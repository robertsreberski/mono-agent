import type { MonitorState } from "@mono-agent/agent-contracts";

import type { PreparedSandboxCommand } from "./sandbox.js";

/**
 * One coalesced batch of monitor stdout lines, or one terminal transition,
 * handed from the kernel-owned watcher process to the host service.
 */
export interface MonitorProcessHandle {
  readonly pid: number | null;
  readonly pgid: number | null;
  readonly startedAt: string;
  /** Resolves once the watched process group has been waited on. */
  readonly completion: Promise<MonitorProcessResult>;
  /** Release the gated target only after PID/PGID/incarnation ownership is durable. */
  readonly release: () => Promise<void>;
  /** Send SIGTERM to the owned group and escalate to SIGKILL after one second. */
  readonly cancel: () => void;
}

/**
 * Exactly what `startPreparedProcess` resolves with. It is deliberately the
 * runner's own shape rather than a monitor-specific one: a hand-written subset
 * silently diverges the first time the runner changes, and the host then reads
 * a field the kernel never sets.
 */
export interface MonitorProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly aborted: boolean;
  readonly timedOut: boolean;
  readonly spawnError: Error | null;
  /** False only when bounded termination settled without proof the owned group exited. */
  readonly groupExitConfirmed?: boolean;
  readonly durationMs: number;
  /**
   * Bounded raw stderr the runner buffered. Under `outputMode: "stream"` stdout
   * is never stored, so this is the only retained output. It is raw: the host
   * redacts and bounds it before it reaches any prompt or projection.
   */
  readonly stderr?: string;
}

export interface MonitorLaunchOptions {
  readonly timeoutMs?: number;
  /** Invoked for each raw stdout chunk; the host owns line splitting and bounds. */
  readonly onStdout?: (chunk: Buffer) => void;
  readonly onStderr?: (chunk: Buffer) => void;
}

export interface MonitorStartRequest {
  /**
   * Exact sandbox-prepared command, prepared through the identical seam Bash
   * uses. The controller takes ownership before start() can settle and must call
   * cleanup after the owned process group exits on every path.
   */
  readonly prepared: PreparedSandboxCommand;
  /** Kernel-produced summary that contains no argument/command values. */
  readonly summary: string;
  /** Model-authored purpose; the host bounds and redacts it before retaining it. */
  readonly description: string;
  /** Explicit per-call runtime budget in milliseconds. Ignored when persistent. */
  readonly timeoutMs?: number;
  /** Run until MonitorStop, agent restart, or the host persistent ceiling. */
  readonly persistent?: boolean;
  /** One-shot launcher bound to the exact prepared command and POSIX group wait. */
  readonly launch: (options?: MonitorLaunchOptions) => MonitorProcessHandle;
}

export interface MonitorStartResult {
  readonly monitorId: string;
  readonly state: Extract<MonitorState, "starting" | "running">;
  readonly startedAt: string;
  /**
   * Runtime budget the host actually granted after its own ceiling was applied.
   * `0` means the monitor is persistent and has no timed deadline.
   */
  readonly maxRuntimeMs: number;
  readonly persistent: boolean;
}

export interface MonitorStopResult {
  readonly monitorId: string;
  readonly state: MonitorState;
  /** False when the monitor was already terminal; stop stays idempotent. */
  readonly stopped: boolean;
}

/** Host budgets a monitor is bounded by, independent of any one request. */
export interface MonitorControllerLimits {
  /** Ceiling for a timed monitor. */
  readonly maxRuntimeMs: number;
  /** Ceiling for a persistent monitor. */
  readonly persistentMaxRuntimeMs: number;
  readonly maxActivePerConversation: number;
}

/** Request-scoped host controller injected only into the Pi-native Monitor tools. */
export interface MonitorsController {
  /** The host's standing ceilings, published so the tool schema can state them. */
  readonly limits?: MonitorControllerLimits;
  start(request: MonitorStartRequest): Promise<MonitorStartResult>;
  stop(monitorId: string): Promise<MonitorStopResult>;
}

/** Bridge the typed host controller to agent-runtime's dependency-free seam. */
export function bridgeMonitorsController(controller: MonitorsController): MonitorsController {
  if (controller === null
    || typeof controller !== "object"
    || typeof controller.start !== "function"
    || typeof controller.stop !== "function") {
    throw new TypeError("Monitors controller must implement start() and stop().");
  }
  const limits = bridgedLimits(controller.limits);
  return Object.freeze({
    ...(limits === undefined ? {} : { limits }),
    async start(request: MonitorStartRequest): Promise<MonitorStartResult> {
      assertKernelStartRequest(request);
      return await controller.start(request);
    },
    async stop(monitorId: string): Promise<MonitorStopResult> {
      if (typeof monitorId !== "string" || monitorId.trim().length === 0 || monitorId.length > 256) {
        throw new TypeError("Kernel monitor stop request is invalid.");
      }
      return await controller.stop(monitorId);
    },
  });
}

/** Copy only well-formed positive budgets; a malformed one is simply unstated. */
function bridgedLimits(
  limits: MonitorControllerLimits | undefined,
): MonitorControllerLimits | undefined {
  if (limits === null || typeof limits !== "object") return undefined;
  const { maxRuntimeMs, persistentMaxRuntimeMs, maxActivePerConversation } = limits;
  if (!positive(maxRuntimeMs) || !positive(persistentMaxRuntimeMs) || !positive(maxActivePerConversation)) {
    return undefined;
  }
  return Object.freeze({ maxRuntimeMs, persistentMaxRuntimeMs, maxActivePerConversation });
}

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function assertKernelStartRequest(request: MonitorStartRequest): void {
  if (request === null || typeof request !== "object"
    || typeof request.summary !== "string"
    || typeof request.description !== "string"
    || request.description.trim().length === 0
    || typeof request.launch !== "function"
    || request.prepared === null
    || typeof request.prepared !== "object"
    || typeof request.prepared.command !== "string"
    || !Array.isArray(request.prepared.args)
    || request.prepared.args.some((argument) => typeof argument !== "string")
    || typeof request.prepared.cwd !== "string"
    || typeof request.prepared.sandboxed !== "boolean"
    || (request.persistent !== undefined && typeof request.persistent !== "boolean")
    || (request.timeoutMs !== undefined
      && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0))) {
    throw new TypeError("Kernel monitor start request is invalid.");
  }
}
