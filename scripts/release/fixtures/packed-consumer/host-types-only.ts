import type { RuntimeRunOptions, MonoRuntimeLike, RuntimeToolLifecycleSink } from "@mono-agent/agent-runtime/host/types";
export type HostContract = { runtime: MonoRuntimeLike; run: RuntimeRunOptions; sink: RuntimeToolLifecycleSink };
