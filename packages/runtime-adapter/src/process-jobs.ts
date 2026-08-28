import type { ProcessJobState } from "@mono-agent/agent-contracts";

import type { PreparedSandboxCommand } from "./sandbox.js";

export interface ProcessJobProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly aborted: boolean;
  readonly timedOut: boolean;
  readonly bufferExceeded: boolean;
  readonly truncated: boolean;
  readonly bytes: number;
  readonly storedBytes: number;
  readonly spawnError: Error | null;
  /** False only when bounded termination settled without proof that the owned group disappeared. */
  readonly groupExitConfirmed?: boolean;
  readonly durationMs: number;
}

export interface ProcessJobLaunchOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly maxBufferBytes?: number;
  readonly onStdout?: (chunk: Buffer) => void;
  readonly onStderr?: (chunk: Buffer) => void;
}

export interface ProcessJobProcessHandle {
  readonly pid: number | null;
  readonly pgid: number | null;
  readonly startedAt: string;
  readonly completion: Promise<ProcessJobProcessResult>;
  /** Release the gated target only after PID/PGID/incarnation ownership is durable. */
  readonly release: () => Promise<void>;
  /** Send SIGTERM to the owned group and escalate to SIGKILL after one second. */
  readonly cancel: () => void;
}

export interface ProcessJobStartRequest {
  readonly tool: "Exec" | "Bash";
  /**
   * Exact sandbox-prepared command. The controller takes ownership before
   * start() can settle and must call cleanup after the owned process group exits
   * on every success/failure/cancellation path. Commands that deliberately
   * create a different POSIX session or process group are outside this ownership
   * contract. Never persist env values or raw argv from this object.
   */
  readonly prepared: PreparedSandboxCommand;
  /** Kernel-produced summary that contains no argument/command values. */
  readonly summary: string;
  /**
   * Model-authored purpose for user-visible lifecycle messages. The host must
   * bound and redact this before retaining it; never persist the raw value.
   */
  readonly description?: string;
  /** Explicit per-call narrowing; omission delegates to compiled host config. */
  readonly timeoutMs?: number;
  /** Explicit per-call preview narrowing; omission delegates to host config. */
  readonly maxOutputChars?: number;
  /** One-shot launcher bound to the exact prepared command and POSIX group wait. */
  readonly launch: (options?: ProcessJobLaunchOptions) => ProcessJobProcessHandle;
}

export interface ProcessJobStartResult {
  readonly jobId: string;
  readonly state: Extract<ProcessJobState, "queued" | "starting" | "running">;
  readonly startedAt: string | null;
  /**
   * Runtime budget the host actually granted, after its own `maxRuntimeMs`
   * ceiling was applied to whatever the caller requested. Optional so an older
   * controller that omits it still satisfies the contract; when present the tool
   * reports it, so a reduced budget can never be silently mistaken for the
   * requested one.
   */
  readonly maxRuntimeMs?: number;
}

/** Host budget a background job is bounded by, independent of any one request. */
export interface ProcessJobControllerLimits {
  readonly maxRuntimeMs: number;
  readonly maxOutputBytes: number;
}

/** Request-scoped host controller injected only into Pi-native Exec/Bash. */
export interface ProcessJobsController {
  /**
   * The host's standing ceiling, published so the tool schema can state it
   * before a job is launched. Optional: a controller that omits it simply
   * leaves the limit unstated rather than failing the contract.
   */
  readonly limits?: ProcessJobControllerLimits;
  start(request: ProcessJobStartRequest): Promise<ProcessJobStartResult>;
}

/** Bridge the typed host controller to agent-runtime's dependency-free seam. */
export function bridgeProcessJobsController(
  controller: ProcessJobsController,
): ProcessJobsController {
  if (controller === null || typeof controller !== "object" || typeof controller.start !== "function") {
    throw new TypeError("Process-jobs controller must implement start().");
  }
  const limits = bridgedLimits(controller.limits);
  return Object.freeze({
    ...(limits === undefined ? {} : { limits }),
    async start(request: ProcessJobStartRequest): Promise<ProcessJobStartResult> {
      assertKernelStartRequest(request);
      return await controller.start(request);
    },
  });
}

/** Copy only well-formed positive budgets; a malformed one is simply unstated. */
function bridgedLimits(
  limits: ProcessJobControllerLimits | undefined,
): ProcessJobControllerLimits | undefined {
  if (limits === null || typeof limits !== "object") return undefined;
  const { maxRuntimeMs, maxOutputBytes } = limits;
  if (!Number.isSafeInteger(maxRuntimeMs) || maxRuntimeMs <= 0) return undefined;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) return undefined;
  return Object.freeze({ maxRuntimeMs, maxOutputBytes });
}

function assertKernelStartRequest(request: ProcessJobStartRequest): void {
  if (request === null || typeof request !== "object"
    || (request.tool !== "Exec" && request.tool !== "Bash")
    || typeof request.summary !== "string"
    || (request.description !== undefined && typeof request.description !== "string")
    || typeof request.launch !== "function"
    || request.prepared === null
    || typeof request.prepared !== "object"
    || typeof request.prepared.command !== "string"
    || !Array.isArray(request.prepared.args)
    || request.prepared.args.some((argument) => typeof argument !== "string")
    || typeof request.prepared.cwd !== "string"
    || typeof request.prepared.sandboxed !== "boolean"
    || (request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0))
    || (request.maxOutputChars !== undefined
      && (!Number.isSafeInteger(request.maxOutputChars) || request.maxOutputChars <= 0))) {
    throw new TypeError("Kernel process-job start request is invalid.");
  }
}
