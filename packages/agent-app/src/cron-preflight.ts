import { spawn as nodeSpawn } from "node:child_process";
import process from "node:process";

import type { ChannelLogger } from "@mono-agent/agent-contracts";
import {
  MAX_CRON_PREFLIGHT_INPUT_BYTES,
  MAX_CRON_PREFLIGHT_REASON_BYTES,
  boundCronPreflightText,
  type CronFiringIdentity,
  type CronPreflightErrorCode,
  type CronPreflightOutcome,
} from "@mono-agent/cron-adapter";

/** Raw stdout ceiling; a decoded 64 KiB input still fits once JSON-escaped. */
export const MAX_CRON_PREFLIGHT_STDOUT_BYTES = 256 * 1024;
/** Raw stderr ceiling. Stderr is diagnostic only and never becomes a verdict. */
export const MAX_CRON_PREFLIGHT_STDERR_BYTES = 8 * 1024;
/** How much of a failed gate's stderr one warn line may carry. */
export const MAX_CRON_PREFLIGHT_STDERR_LOG_BYTES = 1024;
/** Grace between SIGTERM and SIGKILL for a gate that ignores the first signal. */
export const CRON_PREFLIGHT_KILL_GRACE_MS = 2_000;

/**
 * The narrow slice of a Node child process this runner needs. Production uses
 * `node:child_process.spawn`; tests inject a fake that satisfies this shape.
 */
export interface CronPreflightChild {
  readonly stdout: { on(event: "data", listener: (chunk: string | Uint8Array) => void): unknown } | null;
  readonly stderr: { on(event: "data", listener: (chunk: string | Uint8Array) => void): unknown } | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null, signal: string | null) => void): unknown;
  kill(signal?: "SIGTERM" | "SIGKILL"): unknown;
  unref?(): unknown;
}

export interface CronPreflightSpawnOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** The gate's stdin is closed; both output streams are piped and capped. */
  readonly stdio: ["ignore", "pipe", "pipe"];
}

/** Injectable spawn seam; production passes `node:child_process.spawn`. */
export type CronPreflightSpawn = (
  command: string,
  args: readonly string[],
  options: CronPreflightSpawnOptions,
) => CronPreflightChild;

export interface CronPreflightRunInput {
  /** Explicit argv from the job's `preflight` declaration. Never a shell line. */
  readonly argv: readonly string[];
  readonly firing: CronFiringIdentity;
  /** Agent root the gate runs in. */
  readonly cwd: string;
  /** Hard bound for the whole gate; the child is SIGTERMed, then SIGKILLed. */
  readonly timeoutMs: number;
  /** Run cancellation: stop/replace kills the gate and fails it open. */
  readonly abortSignal: AbortSignal;
  /** Base environment; defaults to `process.env`. Identity vars always win. */
  readonly env?: NodeJS.ProcessEnv;
  readonly spawn?: CronPreflightSpawn;
  readonly logger?: ChannelLogger;
}

const defaultSpawn: CronPreflightSpawn = (command, args, options) =>
  nodeSpawn(command, [...args], options) as unknown as CronPreflightChild;

const INVALID_PREFLIGHT_TEXT: unique symbol = Symbol("invalid-preflight-text");
type InvalidPreflightText = typeof INVALID_PREFLIGHT_TEXT;

/**
 * Run one job's preflight argv and resolve its verdict.
 *
 * The gate is advisory and side-effect-free by contract: it receives the
 * firing's identity through `MONO_AGENT_CRON_*` env vars, and every failure —
 * spawn error, non-zero exit, signal, timeout, output over the caps, malformed
 * verdict — resolves as an `error` outcome so the caller runs the job with its
 * plain prompt. Raw stdout, stderr, argv, and env values never leave this
 * module except as a bounded `reason` (stable text, never gate output) and a
 * bounded `warn` line carrying truncated stderr. This function never rejects.
 */
export function runCronPreflight(input: CronPreflightRunInput): Promise<CronPreflightOutcome> {
  return new Promise<CronPreflightOutcome>((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let child: CronPreflightChild | undefined;
    let stdout = "";
    let stderr = "";

    const warnFailure = (code: CronPreflightErrorCode, detail: string): void => {
      input.logger?.warn?.("Cron preflight gate failed open; the job runs with its plain prompt.", {
        jobId: input.firing.jobId,
        runId: input.firing.runId,
        code,
        ...(detail.length === 0
          ? {}
          : { detail: boundCronPreflightText(detail, MAX_CRON_PREFLIGHT_STDERR_LOG_BYTES) }),
      });
    };
    const unref = (timer: ReturnType<typeof setTimeout>): void => {
      (timer as { unref?: () => void }).unref?.();
    };
    const kill = (signal: "SIGTERM" | "SIGKILL"): void => {
      try {
        child?.kill(signal);
      } catch {
        // The gate already exited; the close/error handler owns the outcome.
      }
    };
    // Terminate the gate without letting a stuck child hold the process open.
    const escalate = (): void => {
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), CRON_PREFLIGHT_KILL_GRACE_MS);
      unref(killTimer);
    };
    const settle = (outcome: CronPreflightOutcome): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      input.abortSignal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const fail = (code: CronPreflightErrorCode, reason?: string): void => {
      settle({ outcome: "error", code, ...(reason === undefined ? {} : { reason }) });
    };
    function onAbort(): void {
      escalate();
      fail("signal", "preflight gate was cancelled before it answered");
    }

    if (input.abortSignal.aborted) {
      onAbort();
      return;
    }
    input.abortSignal.addEventListener("abort", onAbort, { once: true });

    timeout = setTimeout(() => {
      // The verdict no longer matters: kill the gate and fail open. SIGKILL
      // still lands even if the child ignores SIGTERM.
      escalate();
      fail("timeout", `preflight gate did not answer within ${String(input.timeoutMs)}ms`);
    }, input.timeoutMs);
    unref(timeout);

    try {
      child = (input.spawn ?? defaultSpawn)(input.argv[0]!, [...input.argv.slice(1)], {
        cwd: input.cwd,
        env: cronPreflightEnv(input),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      warnFailure("spawn_failed", errorMessage(error));
      fail("spawn_failed", "preflight gate could not be started");
      return;
    }
    child.unref?.();

    const onData = (stream: "stdout" | "stderr") => (chunk: string | Uint8Array): void => {
      if (settled) return;
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      if (stream === "stderr") {
        // Diagnostic only: keep the newest bytes bounded so a chatty gate
        // cannot grow this runner's memory or the warn line without limit.
        stderr = boundCronPreflightText(stderr + text, MAX_CRON_PREFLIGHT_STDERR_BYTES);
        return;
      }
      stdout += text;
      if (Buffer.byteLength(stdout, "utf8") > MAX_CRON_PREFLIGHT_STDOUT_BYTES) {
        escalate();
        fail("output_overflow", "preflight gate stdout exceeded the byte cap");
      }
    };
    child.stdout?.on("data", onData("stdout"));
    child.stderr?.on("data", onData("stderr"));

    child.on("error", (error) => {
      if (killTimer !== undefined) clearTimeout(killTimer);
      warnFailure("spawn_failed", errorMessage(error));
      fail("spawn_failed", "preflight gate could not be started");
    });
    child.on("close", (code, signal) => {
      // The gate is gone, so the SIGKILL escalation has nothing left to kill.
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (settled) return;
      if (code === 0) {
        settle(verdictFromStdout(stdout));
        return;
      }
      if (code === null) {
        warnFailure("signal", `gate terminated by ${signal ?? "a signal"}`);
        fail("signal", `preflight gate was terminated by ${signal ?? "a signal"}`);
        return;
      }
      warnFailure("exit_nonzero", stderr);
      fail("exit_nonzero", `preflight gate exited with code ${String(code)}`);
    });
  });
}

/** Inherit the host environment and add the firing identity the gate dedupes on. */
function cronPreflightEnv(input: CronPreflightRunInput): NodeJS.ProcessEnv {
  return {
    ...(input.env ?? process.env),
    MONO_AGENT_CRON_JOB_ID: input.firing.jobId,
    MONO_AGENT_CRON_RUN_ID: input.firing.runId,
    MONO_AGENT_CRON_SCHEDULED_AT: input.firing.scheduledAt,
    MONO_AGENT_CRON_TRIGGER: input.firing.trigger,
  };
}

/**
 * Read the single JSON object a gate writes to stdout. Unknown keys are
 * ignored; only `run` (required boolean), `input`, and `reason` (strings) are
 * read, and their types are strict so a typo cannot become a silent skip.
 */
function verdictFromStdout(stdout: string): CronPreflightOutcome {
  const invalid = (reason: string): CronPreflightOutcome => ({ outcome: "error", code: "invalid_verdict", reason });
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim()) as unknown;
  } catch {
    return { outcome: "error", code: "invalid_json", reason: "preflight gate stdout was not one JSON object" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return invalid("preflight gate verdict was not a JSON object");
  }
  const verdict = parsed as Record<string, unknown>;
  if (typeof verdict.run !== "boolean") {
    return invalid("preflight gate verdict is missing a boolean \"run\"");
  }
  const gateInput = preflightText(verdict.input);
  const reason = preflightText(verdict.reason);
  if (gateInput === INVALID_PREFLIGHT_TEXT || reason === INVALID_PREFLIGHT_TEXT) {
    return invalid("preflight gate verdict has a non-string input or reason");
  }
  if (gateInput !== undefined && Buffer.byteLength(gateInput, "utf8") > MAX_CRON_PREFLIGHT_INPUT_BYTES) {
    return { outcome: "error", code: "output_overflow", reason: "preflight gate input exceeded the byte cap" };
  }
  return {
    outcome: verdict.run ? "run" : "skip",
    ...(gateInput === undefined ? {} : { input: gateInput }),
    ...(reason === undefined ? {} : { reason: boundCronPreflightText(reason, MAX_CRON_PREFLIGHT_REASON_BYTES) }),
  };
}

/** `undefined` means absent, {@link INVALID_PREFLIGHT_TEXT} means the wrong type. */
function preflightText(value: unknown): string | undefined | InvalidPreflightText {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return INVALID_PREFLIGHT_TEXT;
  return value.trim().length === 0 ? undefined : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
