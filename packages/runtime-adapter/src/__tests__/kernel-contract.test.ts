// Compile-time structural contract between this façade's hand-written types
// (src/types.ts) and @mono-agent/agent-runtime's generated kernel types
// (packages/agent-runtime/types/**, built by `tsc -p tsconfig.types.json`
// from the kernel's JSDoc typedefs — see ai/types.js).
//
// This file asserts nothing at runtime; `expectTypeOf(...).toExtend<...>()`
// only compiles if the assignability actually holds, so `tsc --noEmit`
// (`pnpm run typecheck`) is what enforces it. It still runs under
// `vitest run` as a no-op so a type-only regression shows up in `pnpm test`
// too, not just in a separate typecheck step.
//
// Kernel parameter/return/element types are extracted structurally via
// `Parameters<...>`/`ReturnType<...>` off the six consumed kernel symbols
// (see src/runtime-adapter.ts's imports) rather than importing agent-runtime's
// internal type names by name — this only depends on the shape actually
// exercised at the seam, not on kernel type-alias naming.
import { describe, expectTypeOf, it } from "vitest";

import { createPiOAuthApiKeyResolver, createRouterRuntime, createRuntime } from "@mono-agent/agent-runtime";
import { executionModeIncompatibilityReason, parseRuntimeModelReference } from "@mono-agent/agent-runtime/ai/runtime/model-refs.js";
import { listRuntimeBridges } from "@mono-agent/agent-runtime/ai/runtime/registry.js";

import type {
  MonoRuntimeBackendCapabilities,
  MonoRuntimeHostOptions,
  MonoRuntimeLike,
  RuntimeModelReference,
  RuntimeResult,
  RuntimeRunOptions,
} from "../types.js";

type KernelRuntimeInstance = ReturnType<typeof createRuntime>;
type KernelHostOptions = Parameters<typeof createRuntime>[0];
type KernelRunOptions = Parameters<KernelRuntimeInstance["run"]>[1];
type KernelRunResult = Awaited<ReturnType<KernelRuntimeInstance["run"]>>;
type KernelBridgeDescriptor = ReturnType<typeof listRuntimeBridges>[number];
type KernelBridgeCapabilities = ReturnType<KernelBridgeDescriptor["capabilities"]>;

describe("runtime-adapter facade / agent-runtime kernel structural contract", () => {
  it("MonoRuntimeHostOptions is assignable to createRuntime's host parameter", () => {
    expectTypeOf<MonoRuntimeHostOptions>().toExtend<KernelHostOptions>();
  });

  it("the facade RuntimeRunOptions is assignable to createRuntime(...).run's options parameter", () => {
    expectTypeOf<RuntimeRunOptions>().toExtend<KernelRunOptions>();
  });

  it("createRouterRuntime accepts the same host options and stays a MonoRuntimeLike", () => {
    expectTypeOf<Parameters<typeof createRouterRuntime>[0]>().toExtend<{ host?: KernelHostOptions } | undefined>();
    expectTypeOf<ReturnType<typeof createRouterRuntime>>().toExtend<MonoRuntimeLike>();
  });

  it("createRuntime's own return value satisfies the facade's MonoRuntimeLike", () => {
    expectTypeOf<KernelRuntimeInstance>().toExtend<MonoRuntimeLike>();
  });

  it("the kernel's run() result is assignable to the facade RuntimeResult", () => {
    expectTypeOf<KernelRunResult>().toExtend<RuntimeResult>();
  });

  it("listRuntimeBridges' capabilities() result is assignable to MonoRuntimeBackendCapabilities", () => {
    expectTypeOf<KernelBridgeCapabilities>().toExtend<MonoRuntimeBackendCapabilities>();
  });

  it("parseRuntimeModelReference / executionModeIncompatibilityReason keep their real (string in, string|null out) signatures", () => {
    expectTypeOf(parseRuntimeModelReference).toBeCallableWith("claude:claude-sonnet-4-6");
    expectTypeOf(parseRuntimeModelReference).returns.toExtend<RuntimeModelReference>();
    expectTypeOf(executionModeIncompatibilityReason).toBeCallableWith("claude:claude-sonnet-4-6", "cli");
    expectTypeOf(executionModeIncompatibilityReason).returns.toEqualTypeOf<string | null>();
  });

  it("createPiOAuthApiKeyResolver keeps its real (path in, provider resolver out) signature", () => {
    expectTypeOf(createPiOAuthApiKeyResolver).toBeCallableWith({ path: "/tmp/auth.json" });
    expectTypeOf(createPiOAuthApiKeyResolver).returns.toBeFunction();
  });
});
