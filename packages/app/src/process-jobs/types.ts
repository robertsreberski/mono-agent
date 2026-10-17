import type { ProcessJobStartRequest } from "@mono-agent/turn/host/types";
import type { InternalProcessJobRequest } from "../process-jobs-internal.js";

export type ServiceStartRequest = ProcessJobStartRequest | InternalProcessJobRequest;

export const isInternal = (request: ServiceStartRequest): request is InternalProcessJobRequest => "kind" in request && request.kind === "internal";

