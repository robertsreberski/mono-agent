// Per-runtime-instance tool context.
//
// A ToolContext carries the configuration the kernel's internal tool helpers
// (output-truncation, ripgrep, path-resolver, pi-tools, the tool impls) need
// to resolve workdirs, artifact paths, the ripgrep binary, sandbox policy, and
// host-specific brand strings. `createRuntime` builds ONE context per runtime
// instance and threads it to every bridge via `options.toolContext`. Direct
// tool callers create and pass their own context explicitly. No process-global
// tool context exists.
//
// Recognized keys:
//   workspace        — fallback for tool workdir resolution. Default: process.cwd().
//   repoRoot         — secondary allowed root (the host's installation root).
//                      Tool path-allowlist checks accept this in addition to workspace.
//   additionalReadRoots  — extra read-only roots for managed filesystem tools.
//   additionalWriteRoots — extra read/write roots for managed filesystem tools.
//   runId            — used as the subdirectory under toolArtifactDir for tool output.
//   toolArtifactDir  — root for {dir}/tool-output/{runId}/{file} artifact writes
//                      from capChars/formatSearchLines when no run-scoped
//                      persistArtifact sink is attached. Null = no persistence.
//   ripgrepPath      — absolute path to the ripgrep binary. When unset, falls
//                      back to vendored binary, then PATH lookup.
//   qaOutputDir      — fallback for normalizeMcpToolParams when the per-call
//                      runArtifactDir isn't supplied.
//   sandboxPolicy    — optional strict filesystem/process/network sandbox policy.
//   sandboxEngine    — optional concrete engine handed to the injected sandbox
//                      implementation when it prepares subprocess commands.
//   sandbox          — RuntimeSandbox implementation the policy is enforced
//                      through (see ../../agent/sandbox-seam.js). Always resolved,
//                      like runtimeBrand: defaults to passthroughSandbox when
//                      a host doesn't inject a real one.
//   runtimeBrand     — resolved RuntimeBrand object (see runtime-brand.js).
//                      Internal helpers read it to stamp host-specific names
//                      (MCP client name, transcript schema id, doctor command).

// @ts-check

import { delimiter } from "node:path";

import { passthroughSandbox } from "../../agent/sandbox-seam.js";
import { DEFAULT_RUNTIME_BRAND, resolveRuntimeBrand } from "../../runtime-brand.js";

// The data keys (everything except the always-resolved runtimeBrand). A fixed
// list — not `Object.keys(ctx)` — so an unknown key on `next` is ignored, matching
// the supported tool-context contract.
const TOOL_CONTEXT_KEYS = (([
  "workspace",
  "repoRoot",
  "additionalReadRoots",
  "additionalWriteRoots",
  "runId",
  "toolArtifactDir",
  "ripgrepPath",
  "qaOutputDir",
  "sandboxPolicy",
  "sandboxEngine",
]) as const);

/**
 * Build a fresh ToolContext from a partial input. `runtimeBrand` is always
 * resolved (to the defaults when absent); the remaining keys default to
 * undefined and are copied from `input` when present.
 */
export function createToolContext(input: ToolContextOptions = {}): ToolContext {
  const ctx: { [K in keyof ToolContext]: ToolContext[K] | undefined } = {
    workspace: undefined,
    repoRoot: undefined,
    additionalReadRoots: undefined,
    additionalWriteRoots: undefined,
    runId: undefined,
    toolArtifactDir: undefined,
    ripgrepPath: undefined,
    qaOutputDir: undefined,
    sandboxPolicy: undefined,
    sandboxEngine: undefined,
    sandbox: passthroughSandbox,
    runtimeBrand: { ...DEFAULT_RUNTIME_BRAND },
  };
  return updateToolContext(ctx as ToolContext, input);
}

/**
 * Mutate an existing ToolContext in place with the keys present on `next`,
 * leaving untouched keys as-is. Mutating in place (rather than returning a
 * copy) is deliberate: `createRuntime` threads a single context object to its
 * bridges and `configureTools` updates that same reference so subsequent runs
 * observe the change — the configuration owned by this runtime.
 */
export function updateToolContext(ctx: ToolContext, next: ToolContextOptions = {}): ToolContext {
  for (const key of TOOL_CONTEXT_KEYS) {
    // Per-key assignment across a heterogeneous record: TS can't correlate the
    // looked-up value type with `key` across two independent indexed accesses
    // (a known structural limitation, not a real type hazard here).
    if (key in next) ctx[key] = ((next) as any)[key];
  }
  if ("toolEnvironment" in next) {
    const environment = next.toolEnvironment;
    (ctx as { toolEnvironment?: ToolContext["toolEnvironment"] }).toolEnvironment = environment === undefined ? undefined : {
      schema: 1,
      values: { ...environment.values },
      ...(environment.pathPrepend === undefined ? {} : { pathPrepend: [...environment.pathPrepend] }),
    };
  }
  if (next.sandbox !== undefined) {
    ctx.sandbox = next.sandbox;
  }
  if (next.runtimeBrand !== undefined) {
    ctx.runtimeBrand = resolveRuntimeBrand(next.runtimeBrand);
  }
  return ctx;
}

/**
 * Reject missing execution context before a tool can drop host policy.
 */
export function requireToolContext(ctx: ToolContext | null | undefined): ToolContext {
  if (!ctx) {
    throw new Error("Tool execution requires an explicit ToolContext; use createToolContext() and pass it as ctx.");
  }
  return ctx;
}

// Single source of truth for the sandbox policy a tool call runs under.
// Merging (rather than letting the per-call option shadow the context policy)
// keeps the guarantee monotonic (I13): a request-scoped policy can tighten the
// host-configured policy but never weaken or disable it. The merge itself is
// delegated to `ctx.sandbox.mergePolicies` (defaulting to passthroughSandbox)
// so the actual algorithm is host-injected, not hard-coded here.
export function resolveSandboxPolicy(ctx: ToolContext | undefined, requestPolicy: SandboxPolicy = undefined): SandboxPolicy | undefined {
  const sandbox = ctx?.sandbox ?? passthroughSandbox;
  const merged = sandbox.mergePolicies(ctx?.sandboxPolicy ?? undefined, requestPolicy ?? undefined);
  return merged && merged.mode !== "off" ? merged : undefined;
}

/**
 * Compose the process environment overlay for Bash/Exec. The caller-supplied
 * base carries each tool's own hardening values; request values are applied
 * only at this final process boundary. No global environment is mutated.
 */
export function requestToolProcessEnvironment(ctx: ToolContext | undefined, base: Record<string, string | undefined> | undefined = undefined): Record<string, string | undefined> | undefined {
  const request = ctx?.toolEnvironment;
  if (request === undefined) return base;
  const env = { ...(base ?? {}), ...request.values };
  if (Array.isArray(request.pathPrepend) && request.pathPrepend.length > 0) {
    env.PATH = [...request.pathPrepend, process.env.PATH].filter(Boolean).join(delimiter);
  }
  return env;
}

export type RuntimeBrand = import("../../runtime-brand.js").RuntimeBrand;

export type SandboxPolicy = import("../../agent/sandbox-seam.js").SandboxPolicy;

export type RuntimeSandboxEngine = import("../../agent/sandbox-seam.js").RuntimeSandboxEngine;

export type RuntimeSandbox = import("../../agent/sandbox-seam.js").RuntimeSandbox;

export type ToolContext = {
  workspace?: string;
  repoRoot?: string;
  additionalReadRoots?: ReadonlyArray<string>;
  additionalWriteRoots?: ReadonlyArray<string>;
  runId?: string;
  toolArtifactDir?: string;
  ripgrepPath?: string;
  qaOutputDir?: string;
  sandboxPolicy?: SandboxPolicy;
  sandboxEngine?: RuntimeSandboxEngine;
  sandbox: RuntimeSandbox;
  runtimeBrand: RuntimeBrand;
  toolEnvironment?: {
      schema: 1;
      values: Readonly<Record<string, string>>;
      pathPrepend?: readonly string[];
  };
  /**
   * Run-scoped host artifact sink. Not a configurable key: the turn runner
   * attaches it to a per-run copy of the context so per-tool output caps can
   * spill their full text into the run's tool-output directory.
   */
  persistArtifact?: (artifact: {
      filename: string;
      buffer: Buffer;
      toolName: string;
      toolUseId: string | null;
  }) => string | null;
};

export type ToolContextOptions = Omit<Partial<ToolContext>, "runtimeBrand"> & {
  runtimeBrand?: Partial<RuntimeBrand>;
};
