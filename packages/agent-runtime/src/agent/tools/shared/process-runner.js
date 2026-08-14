// @ts-check

import { spawn } from "node:child_process";

export const DEFAULT_PROCESS_BUFFER_BYTES = 8 * 1024 * 1024;
const KILL_GRACE_MS = 1_000;
const PROCESS_JOB_LAUNCH_PAYLOAD_BYTES = 8 * 1024 * 1024;
const PROCESS_JOB_STATUS_BYTES = 64 * 1024;

// Background jobs start this command-agnostic group leader first. The actual
// target crosses fd 3 only after the host has durably recorded the leader's
// PID, PGID, and incarnation. If the host exits before that release, fd 3
// closes empty and no target is ever spawned. Raw argv/environment values are
// therefore absent from both durable state and the gate's process arguments.
const PROCESS_JOB_LAUNCH_GATE_SOURCE = String.raw`
"use strict";
const { spawn } = require("node:child_process");
const { createReadStream, createWriteStream } = require("node:fs");
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const input = createReadStream(null, { fd: 3, autoClose: true });
const chunks = [];
let bytes = 0;
let finished = false;

function finish(value) {
  if (finished) return;
  finished = true;
  const output = createWriteStream(null, { fd: 4, autoClose: true });
  output.once("error", () => { process.exitCode = 1; });
  output.end(JSON.stringify(value), () => { process.exitCode = 0; });
}

function spawnFailure(code) {
  finish({
    code: null,
    signal: null,
    spawnError: {
      message: "The gated target process could not be spawned.",
      ...(typeof code === "string" ? { code } : {}),
    },
  });
}

function forwardOutput(source, destination) {
  let destinationOpen = true;
  const resume = () => source.resume();
  const discard = () => {
    destinationOpen = false;
    source.resume();
  };
  destination.on("drain", resume);
  // If the owning host crashes, its pipe readers disappear. Keep the gate
  // alive as the attestable group leader and drain target output instead of
  // crashing on EPIPE and stranding descendants without a leader.
  destination.on("error", discard);
  source.on("data", (chunk) => {
    if (!destinationOpen) return;
    try {
      if (!destination.write(chunk)) source.pause();
    } catch {
      discard();
    }
  });
}

input.on("data", (chunk) => {
  bytes += chunk.length;
  if (bytes > MAX_PAYLOAD_BYTES) {
    input.destroy();
    spawnFailure("PROCESS_JOB_LAUNCH_PAYLOAD_TOO_LARGE");
    return;
  }
  chunks.push(chunk);
});
input.once("error", (error) => spawnFailure(error && error.code));
input.once("end", () => {
  if (finished) return;
  if (bytes === 0) {
    process.exitCode = 0;
    return;
  }
  let spec;
  try {
    spec = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    spawnFailure("PROCESS_JOB_LAUNCH_PAYLOAD_INVALID");
    return;
  }
  if (!spec || typeof spec.command !== "string" || !Array.isArray(spec.args)
    || spec.args.some((argument) => typeof argument !== "string")
    || (spec.cwd !== undefined && typeof spec.cwd !== "string")
    || !spec.env || typeof spec.env !== "object" || Array.isArray(spec.env)) {
    spawnFailure("PROCESS_JOB_LAUNCH_PAYLOAD_INVALID");
    return;
  }
  let target;
  try {
    target = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      detached: false,
      env: spec.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    spawnFailure(error && error.code);
    return;
  }
  forwardOutput(target.stdout, process.stdout);
  forwardOutput(target.stderr, process.stderr);
  target.once("error", (error) => spawnFailure(error && error.code));
  target.once("close", (code, signal) => {
    finish({ code, signal, spawnError: null });
  });
});
`;

/**
 * Run one already-prepared executable without adding a shell.
 *
 * The result is deliberately loss-aware: stdout/stderr are retained up to the
 * shared byte cap even when the child times out, is aborted, exits by signal,
 * or exceeds that cap.
 *
 * @param {{command: string, args?: string[], cwd?: string, env?: Record<string, string|undefined>}} commandSpec
 * @param {{timeoutMs?: number, signal?: AbortSignal, maxBufferBytes?: number}} [options]
 */
export function runPreparedProcess(
  commandSpec,
  {
    timeoutMs,
    signal,
    maxBufferBytes = DEFAULT_PROCESS_BUFFER_BYTES,
  } = {},
) {
  return startPreparedProcess(commandSpec, {
    timeoutMs,
    signal,
    maxBufferBytes,
  }).completion;
}

/**
 * Start one already-prepared executable and expose its process-group handle.
 *
 * `waitForProcessGroup` is deliberately opt-in so existing foreground tools
 * retain their exact leader/stdio completion semantics. Process jobs enable it
 * through their bound launcher: sandbox cleanup must not run while a detached
 * descendant in the owned group is still alive.
 *
 * @param {{command: string, args?: string[], cwd?: string, env?: Record<string, string|undefined>}} commandSpec
 * @param {{timeoutMs?: number, signal?: AbortSignal, maxBufferBytes?: number, waitForProcessGroup?: boolean, exactEnvironment?: boolean, onStdout?: (chunk: Buffer) => void, onStderr?: (chunk: Buffer) => void}} [options]
 * For process jobs, `release()` is the persistence fence: the target cannot
 * spawn until the host has durably recorded the returned ownership metadata.
 * Foreground handles expose a harmless no-op release for one structural shape.
 *
 * @returns {{pid: number|null, pgid: number|null, startedAt: string, completion: Promise<any>, release: () => Promise<void>, cancel: () => void}}
 */
export function startPreparedProcess(
  commandSpec,
  {
    timeoutMs,
    signal,
    maxBufferBytes = DEFAULT_PROCESS_BUFFER_BYTES,
    waitForProcessGroup = false,
    exactEnvironment = false,
    onStdout,
    onStderr,
  } = {},
) {
  const startedAt = Date.now();
  const gated = waitForProcessGroup && process.platform !== "win32";
  const targetEnvironment = exactEnvironment
    ? exactProcessEnv(commandSpec.env)
    : commandSpec.env
      ? mergedProcessEnv(commandSpec.env)
      : { ...process.env };
  const launchPayload = gated
    ? Buffer.from(JSON.stringify({
      command: commandSpec.command,
      args: commandSpec.args || [],
      ...(commandSpec.cwd === undefined ? {} : { cwd: commandSpec.cwd }),
      env: targetEnvironment,
    }), "utf8")
    : null;
  if (launchPayload !== null && launchPayload.byteLength > PROCESS_JOB_LAUNCH_PAYLOAD_BYTES) {
    throw new RangeError("Process-job launch payload exceeds the safe in-memory gate limit.");
  }
  /** @type {import("node:child_process").ChildProcess|null} */
  let child = null;
  let cancel = () => {};
  let release = async () => {};
  const completion = new Promise((resolve) => {
    try {
      child = spawn(
        gated ? process.execPath : commandSpec.command,
        gated
          ? ["--input-type=commonjs", "--eval", PROCESS_JOB_LAUNCH_GATE_SOURCE]
          : (commandSpec.args || []),
        {
        ...(gated ? {} : { cwd: commandSpec.cwd }),
        detached: process.platform !== "win32",
        env: gated ? {} : targetEnvironment,
        stdio: gated
          ? ["ignore", "pipe", "pipe", "pipe", "pipe"]
          : ["ignore", "pipe", "pipe"],
      },
      );
    } catch (error) {
      resolve({
        code: null,
        signal: null,
        stdout: "",
        stderr: "",
        aborted: false,
        timedOut: false,
        bufferExceeded: false,
        truncated: false,
        bytes: 0,
        storedBytes: 0,
        spawnError: error,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    const stdout = [];
    const stderr = [];
    const state = {
      aborted: false,
      bufferExceeded: false,
      bytes: 0,
      storedBytes: 0,
      spawnError: null,
      timedOut: false,
      truncated: false,
    };
    let targetStatus = null;
    let statusInvalid = false;
    const statusChunks = [];
    let statusBytes = 0;
    let killTimer = null;
    let timeoutTimer = null;
    let settled = false;

    function terminate() {
      if (processLeaderExited(child)) return;
      killProcessGroup(child, "SIGTERM");
      if (killTimer === null) {
        killTimer = setTimeout(() => {
          // Once the exact ChildProcess reports exit, its PID/PGID may be
          // reused. Fail closed instead of signalling by a stale numeric id.
          if (!processLeaderExited(child)) killProcessGroup(child, "SIGKILL");
        }, KILL_GRACE_MS);
        killTimer.unref?.();
      }
    }
    cancel = terminate;

    if (gated) {
      const gate = /** @type {import("node:stream").Writable|undefined} */ (child.stdio?.[3]);
      const status = /** @type {import("node:stream").Readable|undefined} */ (child.stdio?.[4]);
      let releasePromise;
      release = async () => {
        releasePromise ??= new Promise((resolveRelease, rejectRelease) => {
          if (!gate || typeof gate.end !== "function" || launchPayload === null) {
            rejectRelease(new Error("Process-job launch gate is unavailable."));
            return;
          }
          let released = false;
          const rejectOnce = () => {
            if (released) return;
            released = true;
            rejectRelease(new Error("Process-job launch gate closed before release."));
          };
          gate.once("error", rejectOnce);
          gate.end(launchPayload, () => {
            if (released) return;
            released = true;
            gate.off("error", rejectOnce);
            resolveRelease();
          });
        });
        await releasePromise;
      };
      status?.on("data", (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        statusBytes += buffer.length;
        if (statusBytes > PROCESS_JOB_STATUS_BYTES) {
          statusInvalid = true;
          return;
        }
        statusChunks.push(buffer);
      });
      status?.once("error", () => { statusInvalid = true; });
      status?.once("end", () => {
        if (statusInvalid || statusBytes === 0) return;
        try {
          const parsed = JSON.parse(Buffer.concat(statusChunks).toString("utf8"));
          if (validTargetStatus(parsed)) targetStatus = parsed;
          else statusInvalid = true;
        } catch {
          statusInvalid = true;
        }
      });
    }

    function append(target, chunk, observe) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      try { observe?.(buffer); } catch { /* observers cannot break process ownership */ }
      state.bytes += buffer.length;
      const remaining = Math.max(0, maxBufferBytes - state.storedBytes);
      if (remaining > 0) {
        const stored = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer;
        target.push(stored);
        state.storedBytes += stored.length;
      }
      if (buffer.length > remaining) {
        state.bufferExceeded = true;
        state.truncated = true;
        terminate();
      }
    }

    if (Number.isFinite(timeoutMs) && Number(timeoutMs) > 0) {
      timeoutTimer = setTimeout(() => {
        state.timedOut = true;
        terminate();
      }, Number(timeoutMs));
      timeoutTimer.unref?.();
    }

    const onAbort = () => {
      state.aborted = true;
      terminate();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk) => append(stdout, chunk, onStdout));
    child.stderr?.on("data", (chunk) => append(stderr, chunk, onStderr));
    child.once("error", (error) => {
      state.spawnError = error;
    });
    child.once("close", (code, closeSignal) => {
      if (settled) return;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timeoutTimer !== null) clearTimeout(timeoutTimer);
        if (killTimer !== null) clearTimeout(killTimer);
        signal?.removeEventListener?.("abort", onAbort);
        const statusSpawnError = targetStatus?.spawnError
          ? processSpawnError(targetStatus.spawnError)
          : null;
        const missingTargetStatus = gated
          && targetStatus === null
          && closeSignal === null
          && code !== 0
          && !state.timedOut
          && !state.bufferExceeded;
        resolve({
          code: targetStatus?.code ?? code,
          signal: targetStatus?.signal ?? closeSignal,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          ...state,
          spawnError: state.spawnError
            ?? statusSpawnError
            ?? (statusInvalid || missingTargetStatus
              ? new Error("The process-job launch gate exited without a valid target result.")
              : null),
          durationMs: Date.now() - startedAt,
        });
      };
      if (!waitForProcessGroup || process.platform === "win32" || !child?.pid) {
        finish();
        return;
      }
      waitForOwnedProcessGroupExit(child.pid, finish);
    });
  });
  return {
    pid: child?.pid ?? null,
    pgid: process.platform === "win32" ? null : (child?.pid ?? null),
    startedAt: new Date(startedAt).toISOString(),
    completion,
    release: () => release(),
    cancel: () => cancel(),
  };
}

function validTargetStatus(value) {
  if (!value || typeof value !== "object") return false;
  if (value.code !== null && !Number.isInteger(value.code)) return false;
  if (value.signal !== null && typeof value.signal !== "string") return false;
  if (value.spawnError === null) return true;
  return typeof value.spawnError === "object"
    && typeof value.spawnError.message === "string"
    && (value.spawnError.code === undefined || typeof value.spawnError.code === "string");
}

function processSpawnError(value) {
  return Object.assign(
    new Error(value.message),
    typeof value.code === "string" ? { code: value.code } : {},
  );
}

function waitForOwnedProcessGroupExit(pgid, finish) {
  const probe = () => {
    try {
      process.kill(-pgid, 0);
      const timer = setTimeout(probe, 25);
      timer.unref?.();
    } catch (error) {
      if (error?.code === "EPERM") {
        const timer = setTimeout(probe, 25);
        timer.unref?.();
        return;
      }
      finish();
    }
  };
  probe();
}

function mergedProcessEnv(overrides) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function exactProcessEnv(values = {}) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * @param {import("node:child_process").ChildProcess} child
 * @param {NodeJS.Signals} signal
 */
export function killProcessGroup(child, signal) {
  if (!child?.pid) return;
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
  } catch { /* already gone or no longer safely attributable */ }
}

function processLeaderExited(child) {
  return !child?.pid
    || (child.exitCode !== null && child.exitCode !== undefined)
    || (child.signalCode !== null && child.signalCode !== undefined);
}

/**
 * @param {{stdout?: string, stderr?: string}} result
 */
export function combinedProcessOutput(result) {
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  if (stdout && stderr) return `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`;
  return stdout || stderr || "(no output)";
}
