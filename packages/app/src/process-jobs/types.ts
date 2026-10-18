import type { ProcessJobProjection } from "@mono-agent/contracts";
import type { ProcessJobStartRequest } from "@mono-agent/turn/host/types";
import type { ProcessJobOriginRecord } from "./process-jobs-store.js";
import type { WakeRecovery } from "./process-jobs-wake-fence.js";
import type { InternalProcessJobRequest } from "./process-jobs-internal.js";

export type ServiceStartRequest = ProcessJobStartRequest | InternalProcessJobRequest;

export const isInternal = (request: ServiceStartRequest): request is InternalProcessJobRequest => "kind" in request && request.kind === "internal";

export interface ProcessJobWakeInput {
  readonly projection: ProcessJobProjection;
  readonly prompt: string;
  readonly conversationId: string;
  readonly channel: ProcessJobOriginRecord["channel"];
  readonly deliveryKey: string;
  readonly chainDepth: number;
  readonly wakeRecovery?: WakeRecovery;
}
