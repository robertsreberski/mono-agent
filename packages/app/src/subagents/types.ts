import type { RuntimeModelReference, OwnedForegroundProcesses } from "@mono-agent/turn/host/types";
import type { LiveInputMailbox } from "@mono-agent/conversation";
import type { ProcessIncarnation } from "@mono-agent/conversation/process-incarnation";
import type { SubagentSalvage } from "../subagent-salvage.js";
import type { SubagentVerificationTarget, SubagentVerificationDeclaration, SubagentVerificationObservation } from "../subagent-verification-observer.js";
import type { SubagentTurnIntent, SubagentRecoveryFence, SubagentOwnerIdentity, SubagentContinuity, SubagentFailureReason } from "../subagent-registry-ownership.js";
import type { SubagentRecoveryAcknowledgement } from "../subagent-recovery-binding.js";
interface InstanceDefinition {
  readonly name: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly model?: RuntimeModelReference;
  readonly effort?: string;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly mcpServerNames?: readonly string[];
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
}

export interface SubagentQuestion { question: string; options?: string[] }

export interface InstanceUsage { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number }

export interface SubagentInstance {
  id: string;
  conversationId: string;
  name: string;
  systemPrompt: string;
  definition: InstanceDefinition;
  sessionId: string;
  sessionsRoot: string;
  incarnation?: string;
  activeTurn?: SubagentTurnIntent;
  recovery?: SubagentRecoveryFence;
  /** Derived public guidance, never accepted as stored ownership authority. */
  recoveryBlocked?: boolean;
  recoveryJobId?: string;
  /** Derived host-only identity of the last managed publication. */
  settledTurnToken?: string;
  reservation?: { token: string };
  status: "queued" | "idle" | "running" | "awaiting_reply" | "closed" | "expired";
  pendingQuestion?: SubagentQuestion;
  turns: number;
  usage: InstanceUsage;
  createdAt: number;
  updatedAt: number;
  lastStatus?: string;
  lastAnswerHead?: string;
}

export interface SubagentRecoverySubject {
  readonly conversationId: string;
  readonly instanceId: string;
  readonly incarnation?: string;
  readonly owner?: SubagentOwnerIdentity;
  readonly verification?: SubagentVerificationTarget;
}

export interface SubagentRecoveryFacts {
  readonly status: SubagentVerificationObservation["status"];
  readonly commands?: SubagentCommandReceipts;
  readonly observation?: Omit<SubagentVerificationObservation, "schemaVersion" | "policyRevision">;
}

export interface SubagentRecoveryInspection {
  readonly schema: "mono-agent.subagent-recovery.v1";
  readonly instanceId: string;
  readonly incarnation?: string;
  readonly jobId?: string;
  readonly recovery?: SubagentRecoveryFence;
  readonly status: "not_required" | "held" | "ready" | "structured_job_recovery_unavailable" | "observation_policy_unavailable" | "observation_policy_denied" | "observation_unavailable" | "observation_inconsistent" | "observation_truncated";
  readonly facts?: SubagentRecoveryFacts;
  /** Derived authorized evidence only; never persisted or proof of continuity. */
  readonly salvage?: SubagentSalvage;
  readonly parentVerificationRequired: boolean;
  readonly resumable?: true;
  readonly ack?: string;
}

export interface InstanceSpec { verification?: SubagentVerificationDeclaration; id?: string; name: string; systemPrompt: string; definition: InstanceDefinition }

/** A new route for the turn being admitted, persisted on the stored definition so later continuations inherit it. */
export interface InstanceRoute { model?: RuntimeModelReference; effort?: string }

export interface InstanceOutcome { status: string; certifiedTimeout?: true; continuity?: { turnToken: string; state: "retained" | "lost" | "unknown" }; closeAfterSuccess?: boolean; failureKind?: "session_continuity_lost"; usage?: Partial<InstanceUsage>; answerHead?: string; question?: SubagentQuestion }

export interface InstanceRegistryHandle {
  verifyOwner(identity: SubagentOwnerIdentity): Promise<{ retained: boolean; verification?: SubagentVerificationTarget }>;
  inspect(id: string, access?: unknown): Promise<SubagentRecoveryInspection>;
  salvageReleased(identity: SubagentOwnerIdentity): Promise<SubagentSalvage | undefined>;
  checkAcknowledgement(id: string, acknowledgement: SubagentRecoveryAcknowledgement, access?: unknown): Promise<void>;
  publishOwned(phase: "intent" | "confirm" | "finalize" | "acknowledge", publication: SubagentRegistryPublication): Promise<void>;
  list(): Promise<SubagentInstance[]>;
  get(id: string): Promise<SubagentInstance | undefined>;
  create(spec: InstanceSpec, access?: unknown): Promise<SubagentInstance>;
  reserve(id: string, token: string, acknowledgement?: SubagentRecoveryAcknowledgement, access?: unknown, route?: InstanceRoute, createdForAdmission?: boolean): Promise<SubagentInstance>;
  releaseReservation(id: string, token: string): Promise<void>;
  begin(id: string, token?: string, acknowledgement?: SubagentRecoveryAcknowledgement, access?: unknown, route?: InstanceRoute): Promise<SubagentInstance>;
  fence(id: string, outcome: { status: "timeout" | "cancelled" }, turnToken?: string): Promise<void>;
  markAwaiting(id: string, question: SubagentQuestion): Promise<SubagentInstance>;
  finish(id: string, outcome: InstanceOutcome, token?: string): Promise<SubagentInstance>;
  close(id: string, access?: unknown): Promise<SubagentInstance>;
}
/** Only bounded host outcome categories; answer prose is not recovery evidence. */
export interface SubagentDisposition {
  status: "ok" | "awaiting_reply" | "failed" | "timeout" | "cancelled" | "empty" | "interrupted" | "busy";
  continuity: SubagentContinuity;
  reason?: SubagentFailureReason;
  closeAfterSuccess?: boolean;
  /** Intentional parent stop, certified continuity and released ownership only. */
  resumeAfterStop?: true;
  certifiedTimeout?: true;
}

export interface ManagedSubagentAdmission {
  readonly instanceIncarnation: string;
  readonly turnToken: string;
}

export interface ManagedSubagentExecution {
  readonly ownedForegroundProcesses: OwnedForegroundProcesses;
  /** In-process steering mailbox for this detached turn; absent means steering is unavailable. */
  readonly liveInput?: LiveInputMailbox;
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
  /** Durable owner settlement proves the provider and child commands never started. */
  readonly neverStarted?: true;
  readonly outcome?: InstanceOutcome;
}

export interface ManagedSubagentRegistry {
  readonly root: string;
  salvage?(identity: SubagentOwnerIdentity): Promise<SubagentSalvage | undefined>;
  verify(identity: SubagentOwnerIdentity): Promise<void | { readonly retained: boolean; readonly verification?: SubagentVerificationTarget }>;
  publish(phase: "intent" | "confirm" | "finalize" | "acknowledge", publication: SubagentRegistryPublication): Promise<void>;
}
/** App-private, bounded evidence. Reporting terminality never discharges ownership. */
export interface SubagentExecutionOwnership {
  schemaVersion: 1;
  registryRoot?: string;
  disposition?: SubagentDisposition;
  usage?: InstanceUsage;
  instanceIncarnation: string;
  turnToken: string;
  owner: { pid: number; incarnation: ProcessIncarnation; settlement: "not_started" | "running" | "settled" | "dead" | "unknown" };
  revoked: boolean;
  parentStopRequested?: true;
  publication: { sequence: number; state: "pending" | "confirmed"; receiptPending?: boolean; receiptRecorded?: number };
  command?: SubagentOwnedCommand;
  /** Host-bound attempt/call keys. Never evict keys while the turn can execute. */
  seenCalls: string[];
}

export interface SubagentOwnedCommand {
  id: string;
  callKey: string;
  tool: "Exec" | "Bash";
  state: "preparing" | "attested" | "running" | "terminating" | "cleanup_unknown" | "released";
  cwd: string;
  sandboxSettingsPath: string | null;
  pid: number | null;
  pgid: number | null;
  incarnation: ProcessIncarnation | null;
  deadlineAt: number;
  budgetMs?: number;
}
/** Private host measurements, not a verdict about the intended verification. */
export interface SubagentCommandReceipt {
  readonly id: string;
  readonly tool: "Exec" | "Bash";
  readonly cwd: string;
  readonly capturedAt: number;
  readonly budgetMs: number | null;
  readonly durationMs: number | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean | null;
  readonly cancelled: boolean | null;
  readonly truncated: boolean | null;
  readonly completion: "observed" | "unobserved";
  readonly cleanup: "confirmed" | "unknown";
}

export interface SubagentCommandReceipts {
  readonly schemaVersion: 1;
  commands: SubagentCommandReceipt[];
  omitted: number;
}
