import {
  createConfiguredAgentResponder,
  createConfiguredAgentRuntime,
  createConfiguredConversationHarness,
  createConfiguredMemory,
} from "@mono-agent/app";
import type { ConfiguredConversationHarnessOptions, ConfiguredAgentResponderOptions } from "@mono-agent/app";
import type { MonoAgentConfig } from "@mono-agent/config";
import type { ConversationHarness } from "@mono-agent/conversation";
import type { AgentResponder, MemoryStore } from "@mono-agent/contracts";
import type { MonoRuntimeLike, RuntimeModelReference, SandboxEngine } from "@mono-agent/turn/host/types";

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type OverloadPair<F> = F extends {
  (...args: infer A): infer R;
  (...args: infer B): infer S;
} ? [A, R, B, S] : never;
interface ExpectedRuntimeOptions {
  readonly config: MonoAgentConfig;
  readonly cwd?: string;
  readonly model?: RuntimeModelReference;
  readonly sandboxEngine?: SandboxEngine;
}
interface ExpectedMemoryDependencies {
  readonly clock?: () => Date;
  readonly embeddingsFetch?: typeof fetch;
  readonly cwd?: string;
  readonly logger?: { warn(message: string): void };
  readonly memoryRuntime?: MonoRuntimeLike;
  readonly observability?: Pick<ConfiguredConversationHarnessOptions, "observabilityContext">;
}
type ConfiguredAgentRuntimeOptions = Parameters<typeof createConfiguredAgentRuntime>[0];
type ExactPublicContract = [
  Assert<Eq<ConfiguredAgentRuntimeOptions, ExpectedRuntimeOptions>>,
  Assert<Eq<OverloadPair<typeof createConfiguredAgentRuntime>, [
    [config: MonoAgentConfig], MonoRuntimeLike, [options: ExpectedRuntimeOptions], MonoRuntimeLike,
  ]>>,
  Assert<Eq<ReturnType<typeof createConfiguredAgentRuntime>, MonoRuntimeLike>>,
  Assert<Eq<Parameters<typeof createConfiguredAgentRuntime>, [options: ExpectedRuntimeOptions]>>,
  Assert<Eq<ReturnType<typeof createConfiguredConversationHarness>, Promise<ConversationHarness>>>,
  Assert<Eq<Awaited<ReturnType<typeof createConfiguredConversationHarness>>, ConversationHarness>>,
  Assert<Eq<Parameters<typeof createConfiguredConversationHarness>, [options: ConfiguredConversationHarnessOptions]>>,
  Assert<Eq<ReturnType<typeof createConfiguredAgentResponder>, Promise<AgentResponder>>>,
  Assert<Eq<Awaited<ReturnType<typeof createConfiguredAgentResponder>>, AgentResponder>>,
  Assert<Eq<Parameters<typeof createConfiguredAgentResponder>, [options: ConfiguredAgentResponderOptions]>>,
  Assert<Eq<ReturnType<typeof createConfiguredMemory>, Promise<MemoryStore | undefined>>>,
  Assert<Eq<Awaited<ReturnType<typeof createConfiguredMemory>>, MemoryStore | undefined>>,
  Assert<Eq<Parameters<typeof createConfiguredMemory>, [config: MonoAgentConfig, deps?: ExpectedMemoryDependencies]>>,
];

if (false) {
  void (null as unknown as ExactPublicContract);
  const config = null as unknown as MonoAgentConfig;
  const options: ConfiguredConversationHarnessOptions = { config };
  const responderOptions: ConfiguredAgentResponderOptions = options;
  const runtime: MonoRuntimeLike = createConfiguredAgentRuntime(config);
  const ownedRuntime: MonoRuntimeLike = createConfiguredAgentRuntime({ config, cwd: "/fictional" });
  const harness: Promise<ConversationHarness> = createConfiguredConversationHarness(options);
  const responder: Promise<AgentResponder> = createConfiguredAgentResponder(responderOptions);
  const memory: Promise<MemoryStore | undefined> = createConfiguredMemory(config, { clock: () => new Date(0) });
  void runtime; void ownedRuntime; void harness; void responder; void memory;
  const runtimeOptions: ConfiguredAgentRuntimeOptions = { config };
  // @ts-expect-error Runtime configuration remains mandatory in either overload.
  createConfiguredAgentRuntime({});
  // @ts-expect-error Raw runtime config remains readonly.
  runtimeOptions.config = config;
  // @ts-expect-error Harness working-directory slot remains readonly.
  options.cwd = "/fictional/replacement";
  // @ts-expect-error Journal callback slot remains readonly.
  options.onMemoryJournalUnavailable = () => {};
  const journalCallback: NonNullable<ConfiguredConversationHarnessOptions["onMemoryJournalUnavailable"]> = (error) => {
    // @ts-expect-error Journal diagnostics remain unknown, not any.
    error.unchecked;
  };
  void journalCallback;
  // @ts-expect-error Configuration remains mandatory.
  createConfiguredConversationHarness({ cwd: "/fictional" });
  // @ts-expect-error Configured options remain readonly.
  options.config = config;
  // @ts-expect-error Nested model references remain readonly.
  options.model!.reference = "fictional:replacement";
  // @ts-expect-error Callback slots remain readonly.
  options.onMemoryRecallUnavailable = () => {};
  const callback: NonNullable<ConfiguredConversationHarnessOptions["onMemoryRecallUnavailable"]> = (error) => {
    // @ts-expect-error Diagnostics are unknown, not any.
    error.unchecked;
  };
  void callback;
}
