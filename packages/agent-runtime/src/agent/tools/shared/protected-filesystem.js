// Protected-root filesystem operations must cross the native sandbox boundary.
// A host-side path check cannot close a parent-symlink swap between authorization
// and open(2); SRT evaluates the path at the actual child-process syscall.

// @ts-check

import { readToolRuntime } from "./runtime-context.js";
import { runPreparedProcess } from "./process-runner.js";
import { resolveSandboxPolicy } from "./tool-context.js";

const PROTECTED_OPERATION_TIMEOUT_MS = 15_000;

/**
 * @param {{command: string, args?: string[], cwd?: string, env?: Record<string, string|undefined>}} command
 * @param {{sandboxPolicy?: any, sandboxEngine?: any, ctx?: any, input?: string|Buffer, maxBufferBytes?: number}} [options]
 * @returns {Promise<any|null>}
 */
export async function runProtectedFilesystemCommand(command, {
  sandboxPolicy,
  sandboxEngine,
  ctx,
  input,
  maxBufferBytes,
} = {}) {
  const resolvedCtx = ctx ?? readToolRuntime();
  const policy = resolveSandboxPolicy(resolvedCtx, sandboxPolicy);
  if (!hasProtectedRoots(policy)) {
    return null;
  }
  const sandbox = resolvedCtx.sandbox;
  let prepared;
  try {
    prepared = await sandbox.prepareCommand({
      policy,
      engine: sandboxEngine ?? resolvedCtx.sandboxEngine ?? undefined,
      command,
    });
    return await runPreparedProcess(prepared, {
      timeoutMs: PROTECTED_OPERATION_TIMEOUT_MS,
      ...(input === undefined ? {} : { input }),
      ...(maxBufferBytes === undefined ? {} : { maxBufferBytes }),
    });
  } finally {
    await prepared?.cleanup?.();
  }
}

/** @param {any} policy */
function hasProtectedRoots(policy) {
  return policy !== undefined
    && Array.isArray(policy.protectedRoots)
    && policy.protectedRoots.length > 0;
}

/** @param {{sandboxPolicy?: any, ctx?: any}} [options] */
export function protectedFilesystemActive({ sandboxPolicy, ctx } = {}) {
  const resolvedCtx = ctx ?? readToolRuntime();
  return hasProtectedRoots(resolveSandboxPolicy(resolvedCtx, sandboxPolicy));
}

/** @param {any} result */
export function protectedCommandSucceeded(result) {
  return result !== null
    && result.code === 0
    && result.signal === null
    && result.spawnError === null
    && result.timedOut === false
    && result.bufferExceeded === false;
}
