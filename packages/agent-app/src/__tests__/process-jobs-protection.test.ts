import { describe, expect, it } from "vitest";

import type { MonoAgentConfig } from "@mono-agent/config";
import { createSandboxPolicy } from "@mono-agent/runtime-adapter";

import {
  PROCESS_JOBS_UNSAFE_HOST_WARNING,
  processJobsProtectionStatus,
  resolveProcessJobsProtectionPosture,
  unsafeProcessJobsProtectionStatus,
} from "../process-jobs-protection.js";
import type { ProcessJobsRootRegistrySnapshot } from "../process-jobs-root-registry.js";

const PI = { provider: "openai-codex", model: "gpt-5.6-sol", reference: "openai-codex:gpt-5.6-sol" } as const;
const CLAUDE = { provider: "anthropic", model: "claude-opus-4-8", reference: "anthropic:claude-opus-4-8" } as const;
const EMPTY = { kind: "empty", roots: [], protectedRoots: [] } as never;
const READY = { kind: "ready", roots: [{}], protectedRoots: ["private"] } as never;
const FAILED = { kind: "failed", roots: [], protectedRoots: ["control"] } as never;

function config(input: {
  readonly sandbox?: "off" | "native" | "absent";
  readonly primary?: typeof PI | typeof CLAUDE;
  readonly fallback?: typeof PI | typeof CLAUDE;
  readonly child?: typeof PI | typeof CLAUDE;
  readonly memory?: typeof PI | typeof CLAUDE;
} = {}): MonoAgentConfig {
  const sandbox = input.sandbox ?? "off";
  return {
    runtime: {
      model: input.primary ?? PI,
      ...(input.fallback === undefined ? {} : { fallbacks: [{ model: input.fallback }] }),
      workspace: "/agent/workspace",
    },
    ...(input.child === undefined
      ? {}
      : { subagents: { enabled: true, definitions: [{ name: "child", model: input.child }] } }),
    ...(input.memory === undefined
      ? {}
      : { memory: { llm: { provider: "agent-host", model: `${input.memory.provider}:${input.memory.model}` } } }),
    ...(sandbox === "absent"
      ? {}
      : { sandbox: createSandboxPolicy({ mode: sandbox, root: "/agent/workspace" }) }),
  } as never;
}

function resolve(input: {
  readonly enabled?: boolean;
  readonly unsafe?: boolean;
  readonly registry?: ProcessJobsRootRegistrySnapshot;
  readonly coreConfig?: MonoAgentConfig;
} = {}) {
  return resolveProcessJobsProtectionPosture({
    settings: {
      enabled: input.enabled ?? true,
      unsafeAllowUnprotectedState: input.unsafe ?? true,
    },
    registry: input.registry ?? READY,
    coreConfig: input.coreConfig ?? config(),
  });
}

describe("ProcessJobs app-private protection posture", () => {
  it("keeps the safe default inert or SRT-protected", () => {
    const inactive = resolve({ unsafe: false, enabled: false, registry: EMPTY });
    expect(inactive).toMatchObject({
      kind: "inactive",
      suppressSyntheticSandbox: false,
    });
    const protectedPosture = resolve({ unsafe: false, enabled: false, registry: READY });
    expect(protectedPosture).toMatchObject({
      kind: "srt-protected",
      requiresPiNative: true,
      suppressSyntheticSandbox: false,
    });
    expect(unsafeProcessJobsProtectionStatus(inactive)).toBeUndefined();
    expect(unsafeProcessJobsProtectionStatus(protectedPosture)).toBeUndefined();
  });

  it("accepts explicit-off unsafe mode for either enabled jobs or retained roots", () => {
    expect(resolve({ enabled: true, registry: EMPTY })).toMatchObject({
      kind: "unsafe-unprotected",
      retainedRoots: false,
      suppressSyntheticSandbox: true,
      warning: PROCESS_JOBS_UNSAFE_HOST_WARNING,
    });
    const retained = resolve({ enabled: false, registry: READY });
    expect(processJobsProtectionStatus(retained)).toEqual({
      protection: "unsafe-unprotected",
      retainedRoots: true,
      unsafeAllowUnprotectedState: true,
      warning: PROCESS_JOBS_UNSAFE_HOST_WARNING,
    });
  });

  it("rejects unsafe mode without enabled jobs or retained roots", () => {
    expect(() => resolve({ enabled: false, registry: EMPTY })).toThrow(/enabled=true or retained/u);
  });

  it.each(["absent", "native"] as const)(
    "rejects unsafe mode when sandbox.mode is %s",
    (sandbox) => {
      expect(() => resolve({ coreConfig: config({ sandbox }) })).toThrow(/explicit sandbox\.mode of off/u);
    },
  );

  it.each([
    ["primary", { primary: CLAUDE }],
    ["fallback", { fallback: CLAUDE }],
    ["Agent child", { child: CLAUDE }],
    ["agent-host memory", { memory: CLAUDE }],
  ] as const)("accepts a parsed provider route for %s", (_label, route) => {
    expect(resolve({ coreConfig: config(route) })).toMatchObject({ kind: "unsafe-unprotected" });
  });

  it("gives failed registry state precedence over every unsafe eligibility error", () => {
    expect(resolve({
      enabled: false,
      registry: FAILED,
      coreConfig: config({ sandbox: "native", primary: CLAUDE }),
    })).toMatchObject({
      kind: "unavailable",
      suppressSyntheticSandbox: false,
      unsafeAllowUnprotectedState: false,
    });
  });
});
