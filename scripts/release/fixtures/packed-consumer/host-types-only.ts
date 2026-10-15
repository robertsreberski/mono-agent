import type { RuntimeRunOptions, MonoRuntimeLike, RuntimeToolLifecycleSink } from "@mono-agent/turn/host/types";
export type HostContract = { runtime: MonoRuntimeLike; run: RuntimeRunOptions; sink: RuntimeToolLifecycleSink };
