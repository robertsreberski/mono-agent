// Shared structural contract; no host implementation or process runner imports.

/** False only when bounded termination settled without proof that the owned group disappeared. */

/** Release the gated target only after PID/PGID/incarnation ownership is durable. */
/** Send SIGTERM to the owned group and escalate to SIGKILL after one second. */

/**
   * Exact sandbox-prepared command. The controller takes ownership before
   * start() can settle and must call cleanup after the owned process group exits
   * on every success/failure/cancellation path. Commands that deliberately
   * create a different POSIX session or process group are outside this ownership
   * contract. Never persist env values or raw argv from this object.
   */
/** Kernel-produced summary that contains no argument/command values. */
/**
   * Model-authored purpose for user-visible lifecycle messages. The host must
   * bound and redact this before retaining it; never persist the raw value.
   */
/** Omission preserves the terminal wake; false updates lifecycle surfaces only. */
/** Explicit per-call narrowing; omission delegates to compiled host config. */
/** Explicit per-call preview narrowing; omission delegates to host config. */
/** One-shot launcher bound to the exact prepared command and POSIX group wait. */

/**
   * Runtime budget the host actually granted, after its own `maxRuntimeMs`
   * ceiling was applied to whatever the caller requested. Optional so an older
   * controller that omits it still satisfies the contract; when present the tool
   * reports it, so a reduced budget can never be silently mistaken for the
   * requested one.
   */
/** Admission-time snapshot; later cancellations may change the position. */

/** Host budget a background job is bounded by, independent of any one request. */

/** Request-scoped host controller injected only into Pi-native Exec/Bash. */
/**
   * The host's standing ceiling, published so the tool schema can state it
   * before a job is launched. Optional: a controller that omits it simply
   * leaves the limit unstated rather than failing the contract.
   */

/** Exact prepared command; the host owns cleanup from run() invocation onward. */
/** Provider call identity within the host-bound attempt, never a model argument. */
/** One-shot gated launch. The host must persist incarnation before release(). */

/** A turn-scoped owner mints an isolated attempt capability for each Pi invocation. */

export type PreparedSandboxCommand = Readonly<import("../agent/sandbox-seam.js").PreparedSandboxCommand>;

export type ProcessJobState = import("@mono-agent/contracts").ProcessJobState;

export type ProcessJobProcessResult = {
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
  readonly groupExitConfirmed?: boolean;
  readonly durationMs: number;
};

export type ProcessJobLaunchOptions = {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly maxBufferBytes?: number;
  readonly onStdout?: (chunk: Buffer) => void;
  readonly onStderr?: (chunk: Buffer) => void;
};

export type ProcessJobProcessHandle = {
  readonly pid: number | null;
  readonly pgid: number | null;
  readonly startedAt: string;
  readonly completion: Promise<ProcessJobProcessResult>;
  readonly release: () => Promise<void>;
  readonly cancel: () => void;
};

export type ProcessJobStartRequest = {
  readonly tool: "Exec" | "Bash";
  readonly prepared: PreparedSandboxCommand;
  readonly summary: string;
  readonly description?: string;
  readonly wakeOnCompletion?: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputChars?: number;
  readonly launch: (options?: ProcessJobLaunchOptions) => ProcessJobProcessHandle;
};

export type ProcessJobStartResult = {
  readonly jobId: string;
  readonly state: Extract<ProcessJobState, "queued" | "starting" | "running">;
  readonly startedAt: string | null;
  readonly maxRuntimeMs?: number;
  readonly queuePosition?: number;
  readonly queueDeadlineAt?: string;
};

export type ProcessJobControllerLimits = {
  readonly maxRuntimeMs: number;
  readonly maxOutputBytes: number;
};

export type ProcessJobsController = {
  readonly limits?: ProcessJobControllerLimits;
  start(request: ProcessJobStartRequest): Promise<ProcessJobStartResult>;
};

export type OwnedForegroundProcessRequest = {
  readonly tool: "Exec" | "Bash";
  readonly callId: string;
  readonly prepared: PreparedSandboxCommand;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly launch: (options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
    maxBufferBytes?: number;
  }) => ProcessJobProcessHandle;
};

export type OwnedForegroundProcessController = {
  run(request: OwnedForegroundProcessRequest): Promise<ProcessJobProcessResult>;
};

export type OwnedForegroundProcesses = {
  forAttempt(): OwnedForegroundProcessController;
};
