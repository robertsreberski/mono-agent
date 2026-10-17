import type { IncomingMessage } from "node:http";
import type { ContinuationStore, DurableContinuationRecord } from "../continuation-store.js";
import type { ContinuationServiceHandle, ContinuationServiceLogger, ContinuationServiceOptions } from "../continuation-service-types.js";
import type { ContinuationLimits, NamedContinuationRoute } from "../continuations.js";
import type { operatorContinuationPage } from "../continuation-service-helpers.js";

export type ContinuationOperatorOperations = Pick<ContinuationServiceHandle, "retry" | "cancel" | "resolveUnknown" | "health">;

export interface ContinuationProtocolDependencies {
  readonly store: Pick<ContinuationStore, "get" | "mutate">;
  readonly maxDeadlineMs: number;
  readonly limits: Pick<ContinuationLimits, "maxActiveRecords" | "maxActivePerOrigin">;
  readonly namedRoutes: Readonly<Record<string, NamedContinuationRoute>>;
  now(): Date;
  baseUrl(): string;
  deriveResultToken(id: string, taskHash: string): string;
  scheduleProcess(): void;
}

export interface ContinuationOperatorDependencies {
  readonly store: Pick<ContinuationStore, "get" | "mutate" | "list" | "stats">;
  readonly limits: Pick<ContinuationLimits, "deliveryTimeoutMs">;
  readonly recordHistory: ContinuationServiceOptions["recordHistory"];
  now(): Date;
  scheduleProcess(): void;
  isResolvingUnknown(id: string): boolean;
  beginResolvingUnknown(id: string): void;
  finishResolvingUnknown(id: string): void;
  runBoundedOperation<T>(phase: "synthesis" | "delivery", timeoutMs: number, operation: () => Promise<T> | T): Promise<T>;
}

export interface ContinuationHttpOperations extends ContinuationOperatorOperations {
  readonly maxResultBytes: number;
  readonly logger: ContinuationServiceLogger | undefined;
  isStopped(): boolean;
  baseUrl(): string;
  authorizeRunClaim(token: string): (body: unknown, write: (result: Record<string, unknown>) => void) => Promise<void>;
  authorizeDetached(serviceName: string, token: string): void;
  authorizeOperator(request: IncomingMessage): void;
  claimDetached(serviceName: string, body: unknown): Promise<Record<string, unknown>>;
  acceptResult(id: string, token: string, body: unknown): Promise<Record<string, unknown>>;
  authorizedRecord(id: string, token: string): Promise<DurableContinuationRecord>;
  list(url: URL): Promise<ReturnType<typeof operatorContinuationPage>>;
}
