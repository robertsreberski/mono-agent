// Compile-time structural contract between this façade's hand-written types
// (src/types.ts) and @mono-agent/agent-runtime's generated kernel types
// (packages/agent-runtime/types/**, built by `tsc -p tsconfig.types.json`
// from the kernel's JSDoc typedefs — see ai/types.js).
//
// Most assertions are compile-time only: `expectTypeOf(...).toExtend<...>()`
// compiles only when assignability holds, so `tsc --noEmit` (`pnpm run
// typecheck`) enforces the contract. Vitest also executes the public event
// guard's positive and negative boundary cases.
//
// Kernel parameter/return/element types are extracted structurally via
// `Parameters<...>`/`ReturnType<...>` off the six consumed kernel symbols
// (see src/runtime-adapter.ts's imports) rather than importing agent-runtime's
// internal type names by name — this only depends on the shape actually
// exercised at the seam, not on kernel type-alias naming.
import { describe, expect, expectTypeOf, it } from "vitest";

import { createPiOAuthApiKeyResolver, createRuntime } from "@mono-agent/agent-runtime";
import { executionModeIncompatibilityReason, parseRuntimeModelReference } from "@mono-agent/agent-runtime/ai/runtime/model-refs.js";
import { listRuntimeBridges } from "@mono-agent/agent-runtime/ai/runtime/registry.js";

import { createMonoRuntime } from "../runtime-adapter.js";
import type { CreateMonoRuntimeOptions, MonoRuntimeAttemptResolution } from "../runtime-adapter.js";
import { isRuntimeSubagentActivityEvent } from "../index.js";
import type {
  MonoAcpInteractionRequest,
  MonoAcpProfileResolver,
  MonoAcpSessionControlOptions,
  MonoRuntimeBackendCapabilities,
  MonoRuntimeHostOptions,
  RuntimeEventLike,
  RuntimeModelReference,
  RuntimeNativeSubagentsOptions,
  RuntimeResult,
  RuntimeRunOptions,
  RuntimeSubagentActivityEvent,
  RuntimeSubagentActivityPhase,
  RuntimeSubagentIdentity,
  RuntimeToolOptions,
} from "../types.js";

type KernelRuntimeInstance = ReturnType<typeof createRuntime>;
type KernelHostOptions = NonNullable<Parameters<typeof createRuntime>[0]>;
type KernelRunOptions = Parameters<KernelRuntimeInstance["run"]>[1];
type KernelRuntimeEvent = Parameters<NonNullable<KernelRunOptions["onEvent"]>>[0];
type KernelSubagentActivityEvent = Extract<KernelRuntimeEvent, { type: "subagent_activity" }>;
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
  | "settingSources"
  | "codexLoadProjectDocs"
  | "nativeSubagents"
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

  it("keeps provider project-discovery controls typed at the facade/kernel seam", () => {
    expectTypeOf<RuntimeRunOptions["settingSources"]>()
      .toEqualTypeOf<readonly ("user" | "project" | "local")[] | undefined>();
    expectTypeOf<RuntimeRunOptions["codexLoadProjectDocs"]>()
      .toEqualTypeOf<boolean | undefined>();
    expectTypeOf<KernelRunOptions["settingSources"]>()
      .toEqualTypeOf<readonly ("user" | "project" | "local")[] | undefined>();
    expectTypeOf<KernelRunOptions["codexLoadProjectDocs"]>()
      .toEqualTypeOf<boolean | undefined>();
    expectTypeOf<RuntimeRunOptions["nativeSubagents"]>()
      .toEqualTypeOf<RuntimeNativeSubagentsOptions | undefined>();
    expectTypeOf<NonNullable<RuntimeRunOptions["nativeSubagents"]>["provider"]>()
      .toEqualTypeOf<"claude">();
    expectTypeOf<NonNullable<KernelRunOptions["nativeSubagents"]>["provider"]>()
      .toEqualTypeOf<"claude">();
  });

  it("types per-attempt tool-policy projection without opening other request fields", () => {
    const resolution = {
      policyOptions: {
        allowedTools: ["*"],
        disallowedTools: [],
        permissionMode: "plan",
      },
    } satisfies MonoRuntimeAttemptResolution;
    assertAssignable<MonoRuntimeAttemptResolution>(resolution);

    if (false) {
      const invalid = {
        policyOptions: {
          permissionMode: "plan",
          // @ts-expect-error attempt policy projection cannot replace messages.
          messages: [],
        },
      } satisfies MonoRuntimeAttemptResolution;
      assertAssignable<MonoRuntimeAttemptResolution>(invalid);
    }
  });

  it("exports an exact normalized subagent event path while keeping open events permissive", () => {
    const event = {
      type: "subagent_activity",
      phase: "agent_started",
      id: "agent:toolu_parent",
      subagent: {
        id: "toolu_parent",
        nativeId: "provider-task-42",
        name: "researcher",
        callIndex: 0,
        agentPath: "root/researcher",
      },
    } satisfies RuntimeSubagentActivityEvent;
    expectTypeOf<RuntimeSubagentActivityPhase>()
      .toEqualTypeOf<"agent_started" | "started" | "completed" | "message" | "agent_completed">();
    expectTypeOf<RuntimeSubagentIdentity>().toExtend<KernelSubagentActivityEvent["subagent"]>();
    expectTypeOf<KernelSubagentActivityEvent["subagent"]>().toExtend<RuntimeSubagentIdentity>();
    expectTypeOf<RuntimeSubagentActivityEvent>().toExtend<KernelSubagentActivityEvent>();
    expectTypeOf<KernelSubagentActivityEvent>().toExtend<RuntimeSubagentActivityEvent>();
    assertAssignable<RuntimeEventLike>(event);

    const opaqueProviderEvent = {
      type: "subagent_activity",
      vendorPayload: { deliberately: "open" },
    } satisfies RuntimeEventLike;
    assertAssignable<RuntimeEventLike>(opaqueProviderEvent);

    expect(isRuntimeSubagentActivityEvent(event)).toBe(true);
    expect(isRuntimeSubagentActivityEvent(opaqueProviderEvent)).toBe(false);
    expect(isRuntimeSubagentActivityEvent({
      ...event,
      subagent: { ...event.subagent, callIndex: "0" },
    })).toBe(false);
    expect(isRuntimeSubagentActivityEvent({ ...event, role: "system" })).toBe(false);

    const narrowEvent = (candidate: RuntimeEventLike): void => {
      if (isRuntimeSubagentActivityEvent(candidate)) {
        expectTypeOf(candidate).toEqualTypeOf<RuntimeSubagentActivityEvent>();
        expectTypeOf(candidate.type).toEqualTypeOf<"subagent_activity">();
      }
    };
    narrowEvent(event);

    if (false) {
      // @ts-expect-error exact subagent events require their unique activity-row id.
      const missingActivityId: RuntimeSubagentActivityEvent = {
        type: "subagent_activity",
        phase: "agent_started",
        subagent: { id: "toolu_parent", name: "researcher", callIndex: 0 },
      };
      assertAssignable<RuntimeSubagentActivityEvent>(missingActivityId);

      const invalidPhase = {
        type: "subagent_activity",
        id: "agent:toolu_parent",
        // @ts-expect-error normalized subagent events reject unknown phases.
        phase: "queued",
        subagent: { id: "toolu_parent", name: "researcher", callIndex: 0 },
      } satisfies RuntimeSubagentActivityEvent;
      void invalidPhase;

      const missingCallIndex = {
        type: "subagent_activity",
        id: "agent:toolu_parent",
        phase: "agent_started",
        // @ts-expect-error exact subagent identities require a provider call ordinal.
        subagent: { id: "toolu_parent", name: "researcher" },
      } satisfies RuntimeSubagentActivityEvent;
      void missingCallIndex;
    }
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
