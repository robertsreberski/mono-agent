// Process-level configuration for the agent kernel's internal tool helpers.
// The host configures this once at worker boot; internal
// modules (output-truncation, ripgrep, path-resolver, pi-bridge) read from
// it instead of reaching into process.env.
//
// Single shared object is acceptable because the worker is one-task-per-process.
//
// Recognized keys:
//   workspace        — fallback for tool workdir resolution. Default: process.cwd().
//   repoRoot         — secondary allowed root (the host's installation root).
//                      Tool path-allowlist checks accept this in addition to workspace.
//   runId            — used as the subdirectory under toolArtifactDir for tool output.
//   toolArtifactDir  — root for {dir}/tool-output/{runId}/{file} artifact writes
//                      from capChars/formatSearchLines. Null = no persistence.
//   ripgrepPath      — absolute path to the ripgrep binary. When unset, falls
//                      back to vendored binary, then PATH lookup.
//   qaOutputDir      — fallback for normalizeMcpToolParams when the per-call
//                      runArtifactDir isn't supplied.
//   sandboxPolicy    — optional strict filesystem/process/network sandbox policy.
//   runtimeBrand     — resolved RuntimeBrand object (see runtime-brand.js).
//                      Internal helpers read it to stamp host-specific names
//                      (MCP client name, transcript schema id, doctor command).

// @ts-check

import { mergeSandboxPolicies } from "@mono-agent/sandbox";
import { DEFAULT_RUNTIME_BRAND, resolveRuntimeBrand } from "../../../runtime-brand.js";

/** @typedef {import('../../../runtime-brand.js').RuntimeBrand} RuntimeBrand */

/**
 * @typedef {Object} ToolRuntimeContext
 * @property {string} [workspace]
 * @property {string} [repoRoot]
 * @property {string} [runId]
 * @property {string} [toolArtifactDir]
 * @property {string} [ripgrepPath]
 * @property {string} [qaOutputDir]
 * @property {import('@mono-agent/sandbox').SandboxPolicy} [sandboxPolicy]
 * @property {RuntimeBrand} runtimeBrand
 */

/** @type {ToolRuntimeContext} */
const context = {
  workspace: undefined,
  repoRoot: undefined,
  runId: undefined,
  toolArtifactDir: undefined,
  ripgrepPath: undefined,
  qaOutputDir: undefined,
  sandboxPolicy: undefined,
  runtimeBrand: { ...DEFAULT_RUNTIME_BRAND },
};

/**
 * @param {Partial<ToolRuntimeContext>} [next]
 * @returns {void}
 */
export function configureToolRuntime(next = {}) {
  for (const key of /** @type {Array<keyof ToolRuntimeContext>} */ (Object.keys(context))) {
    if (key === "runtimeBrand") continue;
    // Per-key assignment across a heterogeneous record: TS can't correlate the
    // looked-up value type with `key` across two independent indexed accesses
    // (a known structural limitation, not a real type hazard here).
    if (key in next) context[key] = /** @type {any} */ (next)[key];
  }
  if (next.runtimeBrand !== undefined) {
    context.runtimeBrand = resolveRuntimeBrand(next.runtimeBrand);
  }
}

/**
 * @returns {ToolRuntimeContext}
 */
export function readToolRuntime() {
  return context;
}

// Single source of truth for the sandbox policy a tool call runs under.
// Merging (rather than letting the per-call option shadow the context policy)
// keeps the guarantee monotonic: a request-scoped policy can tighten the
// host-configured policy but never weaken or disable it.
/**
 * @param {import('@mono-agent/sandbox').SandboxPolicy} [requestPolicy]
 * @returns {import('@mono-agent/sandbox').SandboxPolicy|undefined}
 */
export function resolveSandboxPolicy(requestPolicy = undefined) {
  const merged = mergeSandboxPolicies(context.sandboxPolicy ?? undefined, requestPolicy ?? undefined);
  return merged && merged.mode !== "off" ? merged : undefined;
}

/**
 * @returns {RuntimeBrand}
 */
export function readRuntimeBrand() {
  return context.runtimeBrand || { ...DEFAULT_RUNTIME_BRAND };
}

/**
 * @returns {void}
 */
export function resetToolRuntime() {
  for (const key of /** @type {Array<keyof ToolRuntimeContext>} */ (Object.keys(context))) {
    context[key] = /** @type {any} */ (key === "runtimeBrand" ? { ...DEFAULT_RUNTIME_BRAND } : undefined);
  }
}
