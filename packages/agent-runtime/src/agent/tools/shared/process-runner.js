// @ts-check

import { spawn } from "node:child_process";

export const DEFAULT_PROCESS_BUFFER_BYTES = 8 * 1024 * 1024;
const KILL_GRACE_MS = 1_000;

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
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      const env = commandSpec.env ? mergedProcessEnv(commandSpec.env) : process.env;
      child = spawn(commandSpec.command, commandSpec.args || [], {
        cwd: commandSpec.cwd,
        detached: process.platform !== "win32",
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
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
    let killTimer = null;
    let timeoutTimer = null;
    let settled = false;

    function terminate() {
      killProcessGroup(child, "SIGTERM");
      if (killTimer === null) {
        killTimer = setTimeout(() => killProcessGroup(child, "SIGKILL"), KILL_GRACE_MS);
        killTimer.unref?.();
      }
    }

    function append(target, chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
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

    child.stdout?.on("data", (chunk) => append(stdout, chunk));
    child.stderr?.on("data", (chunk) => append(stderr, chunk));
    child.once("error", (error) => {
      state.spawnError = error;
    });
    child.once("close", (code, closeSignal) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
      if (killTimer !== null) clearTimeout(killTimer);
      signal?.removeEventListener?.("abort", onAbort);
      resolve({
        code,
        signal: closeSignal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        ...state,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

function mergedProcessEnv(overrides) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
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
  } catch {
    try { process.kill(child.pid, signal); } catch { /* already gone */ }
  }
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
