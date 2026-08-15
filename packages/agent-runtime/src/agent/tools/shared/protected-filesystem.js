// Protected-root filesystem operations must cross the native sandbox boundary.
// A host-side path check cannot close a parent-symlink swap between authorization
// and open(2); SRT evaluates the path at the actual child-process syscall.

// @ts-check

import { basename, isAbsolute, relative, resolve, sep } from "node:path";
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

/**
 * Build a metadata-free operation plan rooted at a configured policy path.
 * Search tools keep the model-controlled target as an argument; file helpers
 * use the stable cwd with their absolute target. In both cases the host avoids
 * target metadata and target-derived cwd resolution before SRT enforces policy.
 *
 * @param {string} target
 * @param {{sandboxPolicy?: any, ctx?: any}} [options]
 * @returns {{cwd: string, searchTarget: string}|null}
 */
export function protectedFilesystemTargetPlan(target, { sandboxPolicy, ctx } = {}) {
  const resolvedCtx = ctx ?? readToolRuntime();
  const policy = resolveSandboxPolicy(resolvedCtx, sandboxPolicy);
  if (!hasProtectedRoots(policy)) return null;
  const resolvedTarget = resolve(target);
  const roots = [
    policy.root,
    ...(Array.isArray(policy.readableRoots) ? policy.readableRoots : []),
    resolvedCtx.workspace,
    resolvedCtx.repoRoot,
    process.cwd(),
  ];
  const cwd = roots
    .filter((root) => typeof root === "string" && root.length > 0)
    .map((root) => resolve(root))
    .find((root) => lexicallyContains(root, resolvedTarget))
    ?? resolve(policy.root || resolvedCtx.workspace || resolvedCtx.repoRoot || process.cwd());
  const rel = relative(cwd, resolvedTarget);
  const searchTarget = rel === ""
    ? "."
    : (!rel.startsWith("..") && !isAbsolute(rel) ? rel : resolvedTarget);
  return { cwd, searchTarget };
}

/** @param {string} searchTarget */
export function protectedDirectorySearchTarget(searchTarget) {
  return searchTarget.endsWith(sep) ? searchTarget : `${searchTarget}${sep}`;
}

/**
 * Scope a target-relative user glob to ripgrep's stable host cwd.
 * @param {string} pattern
 * @param {string} searchTarget
 */
export function scopeProtectedSearchGlob(pattern, searchTarget) {
  const normalizedTarget = normalizeSearchPath(searchTarget);
  if (normalizedTarget === ".") return pattern;
  const negated = pattern.startsWith("!");
  const body = (negated ? pattern.slice(1) : pattern).replace(/^\.\//u, "").replace(/^\/+/u, "");
  const prefix = normalizedTarget
    .split("/")
    .map((part) => part.replace(/[!\\*?\[\]{}]/gu, "\\$&"))
    .join("/");
  return `${negated ? "!" : ""}${prefix}/${body}`;
}

/**
 * Restore the historical target-relative search output after ripgrep runs from
 * the stable policy root.
 * @param {string} line
 * @param {string} searchTarget
 */
export function normalizeProtectedSearchLine(line, searchTarget) {
  const normalizedLine = normalizeSearchPath(line).replace(/^\.\//u, "");
  const normalizedTarget = normalizeSearchPath(searchTarget).replace(/^\.\//u, "");
  if (normalizedTarget === ".") return normalizedLine;
  if (normalizedLine === normalizedTarget) return basename(normalizedTarget);
  if (normalizedLine.startsWith(`${normalizedTarget}/`)) {
    return normalizedLine.slice(normalizedTarget.length + 1);
  }
  if (normalizedLine.startsWith(`${normalizedTarget}:`)) {
    return `${basename(normalizedTarget)}${normalizedLine.slice(normalizedTarget.length)}`;
  }
  return normalizedLine;
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

function normalizeSearchPath(path) {
  const normalized = sep === "\\" ? String(path).replaceAll("\\", "/") : String(path);
  return normalized.replace(/\/+$/u, "") || ".";
}

function lexicallyContains(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
