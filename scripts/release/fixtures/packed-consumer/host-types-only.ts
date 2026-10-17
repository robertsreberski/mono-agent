import type { RuntimeRunOptions, MonoRuntimeLike, RuntimeToolLifecycleSink } from "@mono-agent/turn/host/types";
export type HostContract = { runtime: MonoRuntimeLike; run: RuntimeRunOptions; sink: RuntimeToolLifecycleSink };
import type {
  ParsedModelReference, NormalizedPricing, PricingInputRow,
  RetryableProviderFailureInfo, FailureKind, RuntimeModelRef,
  RuntimeBridge, RuntimeBridgeDescriptor, RuntimeBridgeId,
} from "@mono-agent/turn/ai";
import type { AgentCompactionPolicy } from "@mono-agent/turn/agent";
export type OwnerContracts = {
  parsed: ParsedModelReference; pricing: NormalizedPricing; input: PricingInputRow;
  retryable: RetryableProviderFailureInfo; failure: FailureKind; model: RuntimeModelRef;
  bridge: RuntimeBridge; descriptor: RuntimeBridgeDescriptor; bridgeId: RuntimeBridgeId;
  compaction: AgentCompactionPolicy;
};
