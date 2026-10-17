// Public host restrictions and deliberate adaptations to the canonical kernel.
import { describe, expect, expectTypeOf, it } from "vitest";

import { createPiOAuthApiKeyResolver, createRouterRuntime, createRuntime } from "@mono-agent/turn";
import { parseRuntimeModelReference } from "@mono-agent/turn/ai";
import { listRuntimeBridges } from "@mono-agent/turn/ai";

import { createMonoRuntime } from "@mono-agent/turn/host";
import type { CreateMonoRuntimeOptions, MonoRuntimeAttemptResolution } from "@mono-agent/turn/host/types";
import { isRuntimeSubagentActivityEvent } from "@mono-agent/turn/host/types";
import type {
  MonoRuntimeBackendCapabilities,
  MonoRuntimeHostOptions,
  RuntimeEventLike,
  ProcessJobStartRequest,
  OwnedForegroundProcessRequest,
  RuntimeLiveInputMessage,
  RuntimeModelReference,
  RuntimeResult,
  RuntimeRunOptions,
  RuntimeSubagentActivityEvent,
  RuntimeSubagentActivityPhase,
  RuntimeSubagentIdentity,
  RuntimeToolLifecycleTerminalState,
  RuntimeToolOptions,
} from "../types.js";

type TurnRuntimeInstance = ReturnType<typeof createRuntime>;
type TurnHostOptions = NonNullable<Parameters<typeof createRuntime>[0]>;
type TurnRunOptions = Parameters<TurnRuntimeInstance["run"]>[1];
type TurnRuntimeEvent = Parameters<NonNullable<TurnRunOptions["onEvent"]>>[0];
type TurnSubagentActivityEvent = Extract<TurnRuntimeEvent, { type: "subagent_activity" }>;
type TurnToolOptions = Parameters<TurnRuntimeInstance["configureTools"]>[0];
type TurnRunResult = Awaited<ReturnType<TurnRuntimeInstance["run"]>>;
type TurnBridgeDescriptor = ReturnType<typeof listRuntimeBridges>[number];
type TurnBridgeCapabilities = ReturnType<TurnBridgeDescriptor["capabilities"]>;
type RuntimeRunComparableKeys =
  | "model"
  | "messages"
  | "abortSignal"
  | "onEvent"
  | "toolLifecycleSink"
  | "persistArtifact"
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
  | "processJobs"
  | "ownedForegroundProcesses";
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

describe("host public contract", () => {
  it("keeps public core handoff records open without loosening host storage", () => {
    type Dispatch = Awaited<ReturnType<NonNullable<TurnRuntimeInstance["prepareNativeDispatch"]>>>;
    type Input = Parameters<NonNullable<Dispatch["checkHandoffSummary"]>>[0];
    type Result = Awaited<ReturnType<NonNullable<Dispatch["produceHandoffSummary"]>>>;
    if (false) {
      const input: Input = { prepared: { status: "prepared", checkpoints: [], ledger: [], recent: [], older: [], coverage: [] }, outputReserve: 1 };
      input.prepared.status = "prepared";
      input.prepared.checkpoints[0]!.legacyField.nested = true;
      input.prepared.coverage[0]!.legacyField.nested = true;
      const result = null as unknown as Extract<Result, { status: "ready" }>;
      if (result.status === "ready") {
        result.usage.legacyField.nested = true;
        result.status = "ready";
        // @ts-expect-error summary arrays remain readonly in the public core result.
        result.summary.intent.push("fictional");
      }
      const host = null as unknown as import("../types.js").RuntimeHandoffProducerRequest;
      // @ts-expect-error host checkpoint evidence still requires narrowing from unknown.
      host.prepared.checkpoints[0]!.legacyField.nested = true;
    }
  });

  it("retains the public core result and nested host request guarantees", () => {
    expectTypeOf<RuntimeResult["structuredResult"]>().toBeUnknown();
    expectTypeOf<TurnRunResult["sdk"]>().toEqualTypeOf<"pi" | undefined>();
    expectTypeOf<ReturnType<typeof createRouterRuntime>["run"]>().toEqualTypeOf<TurnRuntimeInstance["run"]>();
    if (false) {
      const host = null as unknown as RuntimeRunOptions;
      // @ts-expect-error model provider remains a readonly host projection.
      host.model.provider = "fictional";
      // @ts-expect-error model id remains a readonly host projection.
      host.model.model = "fictional";
      // @ts-expect-error model reference remains a readonly host projection.
      host.model.reference = "fictional:fictional";
      const result = null as unknown as RuntimeResult;
      // @ts-expect-error structured output must be narrowed from unknown before use.
      result.structuredResult.uncheckedProperty;
      const core = null as unknown as TurnRunResult;
      core.events?.map((event) => event.type.toLowerCase());
      core.events?.push({ type: "fictional" });
      core.runtimeWarnings?.map((warning) => Object.keys(warning));
      core.runtimeWarnings?.push({ warning_kind: "fictional" });
      // @ts-expect-error core events still require a type.
      core.events?.push({});
      // @ts-expect-error the public core bridge result remains Pi-only.
      core.sdk = "fictional";
      const background = null as unknown as ProcessJobStartRequest;
      // @ts-expect-error background prepared command command is readonly.
      background.prepared.command = "fictional";
      // @ts-expect-error background prepared command args is readonly.
      background.prepared.args = [];
      // @ts-expect-error background prepared command cwd is readonly.
      background.prepared.cwd = "/fictional";
      // @ts-expect-error background prepared command env is readonly.
      background.prepared.env = {};
      // @ts-expect-error background prepared command allowLocalBinding is readonly.
      background.prepared.allowLocalBinding = false;
      // @ts-expect-error background prepared command sandboxed is readonly.
      background.prepared.sandboxed = false;
      // @ts-expect-error background prepared command sandboxSettingsPath is readonly.
      background.prepared.sandboxSettingsPath = "/fictional/settings";
      // @ts-expect-error background prepared command cleanup is readonly.
      background.prepared.cleanup = async () => {};
      const foreground = null as unknown as OwnedForegroundProcessRequest;
      // @ts-expect-error foreground prepared command command is readonly.
      foreground.prepared.command = "fictional";
      // @ts-expect-error foreground prepared command args is readonly.
      foreground.prepared.args = [];
      // @ts-expect-error foreground prepared command cwd is readonly.
      foreground.prepared.cwd = "/fictional";
      // @ts-expect-error foreground prepared command env is readonly.
      foreground.prepared.env = {};
      // @ts-expect-error foreground prepared command allowLocalBinding is readonly.
      foreground.prepared.allowLocalBinding = false;
      // @ts-expect-error foreground prepared command sandboxed is readonly.
      foreground.prepared.sandboxed = false;
      // @ts-expect-error foreground prepared command sandboxSettingsPath is readonly.
      foreground.prepared.sandboxSettingsPath = "/fictional/settings";
      // @ts-expect-error foreground prepared command cleanup is readonly.
      foreground.prepared.cleanup = async () => {};
    }
  });

  it("preserves nested readonly host projections of shared facts", () => {
    if (false) {
      const result = null as unknown as RuntimeResult;
      // @ts-expect-error dispatch progress is a readonly host view, not the mutable core object.
      result.dispatchProgress!.armed = false;

      const options = null as unknown as RuntimeRunOptions;
      // @ts-expect-error host tool budgets remain readonly through the request projection.
      options.toolLimits!.bashTimeoutMs = 1;
      // @ts-expect-error host compaction policy remains readonly through the request projection.
      options.compaction!.enabled = false;
      // @ts-expect-error host prompt overrides remain readonly through the request projection.
      options.prompts!.emptyReplyFinalization = () => "replacement";
    }
  });

  it("keeps live-input callbacks source-compatible with contextual-void expression returns", () => {
    const calls: string[] = [];
    const message: RuntimeLiveInputMessage = {
      body: "guide",
      accepted: () => calls.push("accepted"),
      acknowledge: () => calls.push("acknowledge"),
      uncertain: () => calls.push("uncertain"),
      reject: () => calls.push("reject"),
    };
    expect(message.body).toBe("guide");
  });

  it("excludes caller-owned sandbox implementations from createMonoRuntime options", () => {
    expectTypeOf<CreateMonoRuntimeOptions["sandbox"]>().toEqualTypeOf<undefined>();
    expectTypeOf<RuntimeRunOptions["sandbox"]>().toEqualTypeOf<undefined>();
    expectTypeOf<RuntimeToolOptions["sandbox"]>().toEqualTypeOf<undefined>();

    if (false) {
      // @ts-expect-error createMonoRuntime owns and injects the sandbox implementation.
      createMonoRuntime({ sandbox: {} });

      const runtime = createMonoRuntime();
      runtime.run("SYSTEM", {
        model: { provider: "faux", model: "sandbox-test", reference: "faux:sandbox-test" },
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

  it("keeps the run-bound artifact sink out of attempt-resolver ownership", () => {
    if (false) {
      const resolution: MonoRuntimeAttemptResolution = {
        options: {
          // @ts-expect-error route plugins cannot replace the host's run-bound artifact sink.
          persistArtifact: () => "/tmp/resolver-owned",
        },
      };
      assertAssignable<MonoRuntimeAttemptResolution>(resolution);
    }
  });

  it("MonoRuntimeHostOptions is assignable to createRuntime's host parameter", () => {
    const facade = null as unknown as WithoutConcreteSandboxEngine<MonoRuntimeHostOptions>;
    assertAssignable<WithoutConcreteSandboxEngine<TurnHostOptions>>(facade);
  });

  it("the facade RuntimeRunOptions is assignable to createRuntime(...).run's options parameter", () => {
    const facade = null as unknown as RuntimeRunComparableOptions;
    assertAssignable<TurnRunOptions>(facade);
  });

  it("keeps the public lifecycle sink exact for direct TypeScript consumers", () => {
    if (false) {
      const runtime = createRuntime();
      void runtime.run("SYSTEM", {
        model: {
          provider: "faux",
          model: "lifecycle-type-contract",
          reference: "faux:lifecycle-type-contract",
        },
        messages: [],
        toolLifecycleSink: async (event) => {
          if (event.phase === "invocation") {
            expectTypeOf(event.toolName).toEqualTypeOf<string>();
            // @ts-expect-error invocation events do not expose terminal state.
            void event.state;
          } else {
            expectTypeOf(event.state).toEqualTypeOf<RuntimeToolLifecycleTerminalState>();
            expectTypeOf(event.failureKind).toEqualTypeOf<string | undefined>();
          }
          return {
            persistence: event.phase === "invocation" ? "deferred" : "persisted",
            artifactReferences: [{ id: "artifact-1", available: true }],
          };
        },
      });
    }
  });

  it("rejects provider controls that only the deleted bridges honored", () => {
    // These were typed, forwarded and silently ignored once their bridges were
    // removed — a caller could set one and get different behavior than the
    // published contract promised. `never` makes that a compile error instead.
    expectTypeOf<RuntimeRunOptions["settingSources"]>().toEqualTypeOf<undefined>();
    expectTypeOf<RuntimeRunOptions["codexLoadProjectDocs"]>().toEqualTypeOf<undefined>();
    expectTypeOf<RuntimeRunOptions["codexSandboxNetworkAccess"]>().toEqualTypeOf<undefined>();
    // `fastMode` was a Claude concept and native teammate definitions were
    // projected only by the deleted Claude bridges; the Pi bridge hardcodes an
    // empty `nativeSubagentsUsed`, so both were accepted and ignored.
    expectTypeOf<RuntimeRunOptions["fastMode"]>().toEqualTypeOf<undefined>();
    expectTypeOf<RuntimeRunOptions["nativeSubagents"]>().toEqualTypeOf<undefined>();
  });

  it("types per-attempt tool-policy projection without opening other request fields", () => {
    const resolution = {
      policyOptions: {
        allowedTools: ["*"],
        disallowedTools: [],
      },
    } satisfies MonoRuntimeAttemptResolution;
    assertAssignable<MonoRuntimeAttemptResolution>(resolution);

    if (false) {
      const invalid = {
        policyOptions: {
          allowedTools: [],
          // @ts-expect-error attempt policy projection cannot replace messages.
          messages: [],
        },
      } satisfies MonoRuntimeAttemptResolution;
      assertAssignable<MonoRuntimeAttemptResolution>(invalid);

      const invalidProcessJobsResolver = {
        options: {
          // @ts-expect-error route plugins cannot replace the host process-job owner.
          processJobs: { start: async () => ({ jobId: "fake", state: "queued", startedAt: null }) },
        },
      } satisfies MonoRuntimeAttemptResolution;
      void invalidProcessJobsResolver;
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
    expectTypeOf<RuntimeSubagentIdentity>().toExtend<TurnSubagentActivityEvent["subagent"]>();
    expectTypeOf<TurnSubagentActivityEvent["subagent"]>().toExtend<RuntimeSubagentIdentity>();
    expectTypeOf<RuntimeSubagentActivityEvent>().toExtend<TurnSubagentActivityEvent>();
    expectTypeOf<TurnSubagentActivityEvent>().toExtend<RuntimeSubagentActivityEvent>();
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

    // Attribution rides the identity: a launch route on agent_started and the
    // final accounting on agent_completed both narrow; a non-record never does.
    const launch = {
      ...event,
      subagent: {
        ...event.subagent,
        attribution: {
          requested: { model: "anthropic:parent", effort: "xhigh" },
          disposition: "unknown",
          transitions: [],
          retries: [],
        },
      },
    } satisfies RuntimeSubagentActivityEvent;
    expect(isRuntimeSubagentActivityEvent(launch)).toBe(true);
    expect(isRuntimeSubagentActivityEvent({
      ...event,
      subagent: { ...event.subagent, attribution: "anthropic:parent" },
    })).toBe(false);

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
    assertAssignable<WithoutConcreteSandboxEngine<TurnToolOptions>>(facade);
  });

  it("the kernel's run() result is assignable to the facade RuntimeResult", () => {
    expectTypeOf<TurnRunResult>().toExtend<RuntimeResult>();
  });

  it("listRuntimeBridges' capabilities() result is assignable to MonoRuntimeBackendCapabilities", () => {
    expectTypeOf<TurnBridgeCapabilities>().toExtend<MonoRuntimeBackendCapabilities>();
  });

  it("parseRuntimeModelReference keeps its real string-in signature", () => {
    expectTypeOf(parseRuntimeModelReference).toBeCallableWith("anthropic:claude-sonnet-4-6");
    expectTypeOf(parseRuntimeModelReference).returns.toExtend<RuntimeModelReference>();
  });

  it("createPiOAuthApiKeyResolver keeps its real (path in, provider resolver out) signature", () => {
    expectTypeOf(createPiOAuthApiKeyResolver).toBeCallableWith({ path: "/tmp/auth.json" });
    expectTypeOf(createPiOAuthApiKeyResolver).returns.toBeFunction();
  });
});

// Full request and attempt assignment, not only the comparable-key subset above.
// These bodies are never executed; the host typecheck verifies their contracts.
function checkFullRequest(options: RuntimeRunOptions): void {
  void createRuntime().run("SYSTEM", options);
}
function checkAttemptResolution(resolution: MonoRuntimeAttemptResolution): void {
  // Exercise the host overload, not Parameters' preserved public-core signature.
  void createRouterRuntime({ resolveAttempt: () => resolution });
}
if (false) {
  checkFullRequest({ model: parseRuntimeModelReference("fictional:fixture"), messages: [], abortSignal: new AbortController().signal });
  checkAttemptResolution({ runtime: createMonoRuntime() });
}

it("excludes the retired scheduling key from core and host contracts", () => {
  expectTypeOf<Extract<"piToolParallelismMode", keyof TurnRunOptions>>().toBeNever();
  expectTypeOf<Extract<"piToolParallelismMode", KnownKeys<RuntimeRunOptions>>>().toBeNever();
  if (false) {
    const host = null as unknown as RuntimeRunOptions;
    // @ts-expect-error the open host record exposes unknown, not an alias type.
    const oldMode: "all" | "one-at-a-time" | undefined = host.piToolParallelismMode;
    void oldMode;
    const core = null as unknown as TurnRunOptions;
    // @ts-expect-error direct core callers must migrate too.
    core.piToolParallelismMode = "all";
  }
});
