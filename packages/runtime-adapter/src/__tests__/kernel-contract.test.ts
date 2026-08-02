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

import { createPiOAuthApiKeyResolver, createRuntime } from "@mono-agent/agent-runtime";
import { executionModeIncompatibilityReason, parseRuntimeModelReference } from "@mono-agent/agent-runtime/ai/runtime/model-refs.js";
import { listRuntimeBridges } from "@mono-agent/agent-runtime/ai/runtime/registry.js";

import { createMonoRuntime } from "../runtime-adapter.js";
import type { CreateMonoRuntimeOptions, MonoRuntimeAttemptResolution } from "../runtime-adapter.js";
import type {
  MonoAcpInteractionRequest,
  MonoAcpProfileResolver,
  MonoAcpSessionControlOptions,
  MonoRuntimeBackendCapabilities,
  MonoRuntimeHostOptions,
  RuntimeModelReference,
  RuntimeResult,
  RuntimeRunOptions,
  RuntimeToolOptions,
} from "../types.js";

type KernelRuntimeInstance = ReturnType<typeof createRuntime>;
type KernelHostOptions = NonNullable<Parameters<typeof createRuntime>[0]>;
type KernelRunOptions = Parameters<KernelRuntimeInstance["run"]>[1];
type KernelToolOptions = Parameters<KernelRuntimeInstance["configureTools"]>[0];
type KernelRunResult = Awaited<ReturnType<KernelRuntimeInstance["run"]>>;
type KernelBridgeDescriptor = ReturnType<typeof listRuntimeBridges>[number];
type KernelBridgeCapabilities = ReturnType<KernelBridgeDescriptor["capabilities"]>;
type MonoAcpElicitationInteraction = Extract<MonoAcpInteractionRequest, { kind: "elicitation" }>;
type MonoAcpFormPayload = Extract<MonoAcpElicitationInteraction["payload"], { mode: "form" }>;
type MonoAcpResolvedProfile = NonNullable<Awaited<ReturnType<MonoAcpProfileResolver>>>;
type MonoAcpProfileCallbacks = NonNullable<MonoAcpResolvedProfile["clientCallbacks"]>;
type MonoAcpCallback<K extends keyof MonoAcpProfileCallbacks> = NonNullable<MonoAcpProfileCallbacks[K]>;
type MonoAcpCallbackPayload<K extends keyof MonoAcpProfileCallbacks> = Parameters<MonoAcpCallback<K>>[0];
type MonoAcpCallbackContext<K extends keyof MonoAcpProfileCallbacks> = Parameters<MonoAcpCallback<K>>[1];
type RuntimeRunComparableKeys =
  | "model"
  | "messages"
  | "abortSignal"
  | "executionMode"
  | "onEvent"
  | "effort"
  | "cwd"
  | "mcpServers"
  | "allowedTools"
  | "disallowedTools"
  | "maxTurns"
  | "sandboxPolicy"
  | "toolLimits"
  | "compaction"
  | "prompts"
  | "acpSessionTokenKey";
type RuntimeRunComparableOptions = Pick<RuntimeRunOptions, RuntimeRunComparableKeys>;
type KnownKeys<T> = {
  [K in keyof T]: string extends K
    ? never
    : number extends K
      ? never
      : symbol extends K
        ? never
        : K;
}[keyof T];
type WithoutConcreteSandboxEngine<T> = Pick<
  NonNullable<T>,
  Exclude<KnownKeys<NonNullable<T>>, "sandboxEngine">
>;

function assertAssignable<T>(_value: T): void {
  // Compile-time only.
}

describe("runtime-adapter facade / agent-runtime kernel structural contract", () => {
  it("excludes caller-owned sandbox implementations from createMonoRuntime options", () => {
    expectTypeOf<CreateMonoRuntimeOptions["sandbox"]>().toEqualTypeOf<undefined>();
    expectTypeOf<RuntimeRunOptions["sandbox"]>().toEqualTypeOf<undefined>();
    expectTypeOf<RuntimeToolOptions["sandbox"]>().toEqualTypeOf<undefined>();

    if (false) {
      // @ts-expect-error runtime-adapter owns and injects the sandbox implementation.
      createMonoRuntime({ sandbox: {} });

      const runtime = createMonoRuntime();
      runtime.run("SYSTEM", {
        model: { sdk: "pi", provider: "faux", model: "sandbox-test" },
        messages: [],
        abortSignal: new AbortController().signal,
        // @ts-expect-error request extensions may supply policy/engine data, never the implementation.
        sandbox: {},
      });
      runtime.configureTools?.({
        // @ts-expect-error configureTools may supply policy/engine data, never the implementation.
        sandbox: {},
      });

      const resolution: MonoRuntimeAttemptResolution = {
        options: {
          // @ts-expect-error route plugins cannot replace the mono sandbox implementation.
          sandbox: {},
        },
      };
      assertAssignable<MonoRuntimeAttemptResolution>(resolution);
    }
  });

  it("MonoRuntimeHostOptions is assignable to createRuntime's host parameter", () => {
    const facade = null as unknown as WithoutConcreteSandboxEngine<MonoRuntimeHostOptions>;
    assertAssignable<WithoutConcreteSandboxEngine<KernelHostOptions>>(facade);
  });

  it("the facade RuntimeRunOptions is assignable to createRuntime(...).run's options parameter", () => {
    expectTypeOf<RuntimeRunOptions["executionMode"]>()
      .toEqualTypeOf<"sdk" | "cli" | "acp" | undefined>();
    const facade = null as unknown as RuntimeRunComparableOptions;
    assertAssignable<KernelRunOptions>(facade);
  });

  it("the facade RuntimeToolOptions is assignable to createRuntime(...).configureTools options except for the concrete sandbox engine", () => {
    const facade = null as unknown as WithoutConcreteSandboxEngine<RuntimeToolOptions>;
    assertAssignable<WithoutConcreteSandboxEngine<KernelToolOptions>>(facade);
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

  it("keeps typed ACP interaction payloads while hiding protocol session ids", () => {
    const assertInteractionContract = (request: MonoAcpInteractionRequest): void => {
      if (request.kind === "permission") {
        assertAssignable<readonly unknown[]>(request.payload.options);
        assertAssignable<object>(request.payload.toolCall);
        // @ts-expect-error protocol session ids are private connection state.
        assertAssignable<string>(request.payload.sessionId);
      } else {
        assertAssignable<string>(request.payload.message);
        assertAssignable<string>(request.payload.mode);
      }

      const formPayload = null as unknown as MonoAcpFormPayload;
      assertAssignable<object>(formPayload.requestedSchema);
      // @ts-expect-error known elicitation variants also hide protocol session ids.
      assertAssignable<string>(formPayload.sessionId);
    };

    expectTypeOf(assertInteractionContract).parameter(0).toEqualTypeOf<MonoAcpInteractionRequest>();
  });

  it("requires a binary token key for ACP session management options", () => {
    expectTypeOf<MonoAcpSessionControlOptions["acpSessionTokenKey"]>()
      .toEqualTypeOf<Uint8Array>();

    if (false) {
      // @ts-expect-error list/delete options require the host-owned token key.
      const missingKey: MonoAcpSessionControlOptions = { resolveAcpProfile: async () => null };
      assertAssignable<MonoAcpSessionControlOptions>(missingKey);
    }
  });

  it("keeps raw protocol ids out of profile callbacks", () => {
    if (false) {
      const permission = null as unknown as MonoAcpCallbackPayload<"requestPermission">;
      assertAssignable<readonly unknown[]>(permission.options);
      // @ts-expect-error opaque correlation belongs in AcpCallbackContext, not the protocol-derived payload.
      assertAssignable<string>(permission.providerSessionId);
      // @ts-expect-error profile callbacks receive the opaque provider handle, never the raw protocol id.
      assertAssignable<string>(permission.sessionId);

      const context = null as unknown as MonoAcpCallbackContext<"requestPermission">;
      assertAssignable<string | undefined>(context.providerSessionId);

      const elicitation = null as unknown as MonoAcpCallbackPayload<"createElicitation">;
      assertAssignable<string>(elicitation.message);
      assertAssignable<string>(elicitation.mode);
      // @ts-expect-error elicitation callbacks hide raw protocol ids too.
      assertAssignable<string>(elicitation.sessionId);

      const read = null as unknown as MonoAcpCallbackPayload<"readTextFile">;
      assertAssignable<string>(read.path);
      // @ts-expect-error filesystem callbacks hide raw protocol ids.
      assertAssignable<string>(read.sessionId);

      const write = null as unknown as MonoAcpCallbackPayload<"writeTextFile">;
      assertAssignable<string>(write.path);
      assertAssignable<string>(write.content);
      // @ts-expect-error filesystem callbacks discard protocol metadata.
      assertAssignable<object>(write._meta);

      const createTerminal = null as unknown as MonoAcpCallbackPayload<"createTerminal">;
      assertAssignable<string>(createTerminal.command);
      // @ts-expect-error terminal callbacks hide raw protocol ids.
      assertAssignable<string>(createTerminal.sessionId);

      const terminalOutput = null as unknown as MonoAcpCallbackPayload<"terminalOutput">;
      assertAssignable<string>(terminalOutput.terminalId);
      const terminalWait = null as unknown as MonoAcpCallbackPayload<"waitForTerminalExit">;
      assertAssignable<string>(terminalWait.terminalId);
      const terminalKill = null as unknown as MonoAcpCallbackPayload<"killTerminal">;
      assertAssignable<string>(terminalKill.terminalId);
      const terminalRelease = null as unknown as MonoAcpCallbackPayload<"releaseTerminal">;
      assertAssignable<string>(terminalRelease.terminalId);

      const update = null as unknown as MonoAcpCallbackPayload<"sessionUpdate">;
      assertAssignable<object>(update.update);
      // @ts-expect-error opaque correlation belongs in AcpCallbackContext, not the protocol-derived payload.
      assertAssignable<string>(update.providerSessionId);
      // @ts-expect-error streamed profile callbacks also hide the raw protocol id.
      assertAssignable<string>(update.sessionId);

      const complete = null as unknown as MonoAcpCallbackPayload<"elicitationComplete">;
      assertAssignable<string>(complete.elicitationId);
      // @ts-expect-error notification callbacks discard protocol metadata.
      assertAssignable<object>(complete._meta);
    }
  });
});
