import type { IncomingMessage } from "node:http";
import type { ContinuationStore, DurableContinuationRecord, ContinuationOriginContextReference } from "./continuation-store.js";
import type { ClaimBinding, ContinuationServiceHandle, ContinuationServiceLogger, ContinuationServiceOptions, ResolvedOriginContext } from "./continuation-service-types.js";
import type { ContinuationLimits, NamedContinuationRoute } from "./continuations.js";
import type { operatorContinuationPage } from "./continuation-service-helpers.js";

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

export interface ContinuationOriginDependencies {
  readonly store: Pick<ContinuationStore, "list" | "mutate" | "stageOriginContext" | "activateOriginContextGroup" | "loadOriginContext">;
  readonly instanceId: string;
  now(): Date;
  isStopped(): boolean;
  claimDrain(binding: ClaimBinding): Promise<void> | undefined;
  beginSettlement(binding: ClaimBinding): (() => void) | undefined;
  settleBinding(binding: ClaimBinding): void;
  bindingMac(record: DurableContinuationRecord, reference: ContinuationOriginContextReference): string;
  scheduleProcess(): void;
}

export interface ContinuationDispatchDependencies {
  readonly store: Pick<ContinuationStore, "list" | "get" | "mutate">;
  readonly instanceId: string;
  readonly leaseMs: number;
  readonly limits: Pick<ContinuationLimits, "maxConcurrent" | "synthesisTimeoutMs" | "deliveryTimeoutMs">;
  readonly synthesisPreflight: ContinuationServiceOptions["synthesisPreflight"];
  readonly synthesize: ContinuationServiceOptions["synthesize"];
  readonly deliver: ContinuationServiceOptions["deliver"];
  now(): Date;
  isStopped(): boolean;
  isSupervised(id: string): boolean;
  startDueJobs(limit: number): Promise<readonly Promise<boolean>[]>;
  throwIfStopping(): void;
  resolveOriginContext(record: DurableContinuationRecord): Promise<ResolvedOriginContext>;
  runBoundedOperation<T>(phase: "synthesis" | "delivery", timeoutMs: number, operation: () => Promise<T> | T): Promise<T>;
}
