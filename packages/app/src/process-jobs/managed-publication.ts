import type { DurableProcessJobRecord } from "./process-jobs-store.js";
import { isTerminalProcessJobState } from "./process-jobs-store.js";
import { hasPendingSubagentPublication, hasUnresolvedSubagentOwnership } from "../subagents/subagent-execution-ownership.js";
import type { SubagentRegistryPublication } from "../subagents/types.js";
import type { SubagentOwnerIdentity } from "../subagents/subagent-registry-ownership.js";

export interface ManagedPublicationOperations {
  assertWritable(): void;
  read(jobId: string): Promise<DurableProcessJobRecord | undefined>;
  matchesRegistry(root: string | undefined): boolean;
  identity(record: DurableProcessJobRecord): SubagentOwnerIdentity;
  neverStarted(record: DurableProcessJobRecord): boolean;
  publish(phase: "intent" | "confirm" | "finalize" | "acknowledge", publication: SubagentRegistryPublication): Promise<void>;
  confirm(jobId: string, publication: SubagentRegistryPublication): Promise<void>;
  recordCertificate(jobId: string, publication: SubagentRegistryPublication): Promise<void>;
  acknowledgeReceipt(jobId: string, publication: SubagentRegistryPublication, record: DurableProcessJobRecord): Promise<void>;
  discardArtifacts(jobId: string): Promise<void>;
  finish(jobId: string, released: boolean, rejectedAdmission: boolean): void;
}

export async function publishManagedJob(jobId: string, operations: ManagedPublicationOperations): Promise<void> {
  operations.assertWritable();
  const record = await operations.read(jobId);
  const owner = record?.subagentOwnership;
  if (!record || !owner?.disposition || !hasPendingSubagentPublication(record)) return;
  if (!operations.matchesRegistry(owner.registryRoot)) throw new Error("Managed subagent registry is unavailable.");
  const publication: SubagentRegistryPublication = { identity: operations.identity(record), sequence: owner.publication.sequence,
    disposition: owner.disposition, released: !hasUnresolvedSubagentOwnership(record) && isTerminalProcessJobState(record.state),
    ...(operations.neverStarted(record) ? { neverStarted: true as const } : {}),
    outcome: { status: owner.disposition.status, ...(owner.usage ? { usage: owner.usage } : {}), ...(record.subagentQuestion ? { question: record.subagentQuestion } : {}) } };
  if (owner.publication.state === "pending") {
    await operations.publish("intent", publication);
    await operations.publish("confirm", publication);
    await operations.confirm(jobId, publication);
  }
  if (publication.released) {
    // Never hold the service lock while entering the registry transaction.
    // It verifies the committed job proof and durably writes its certificate.
    if (owner.publication.receiptRecorded !== publication.sequence) {
      await operations.publish("finalize", publication);
      await operations.recordCertificate(jobId, publication);
    }
    // Registry deletion is safe only after the job has durably copied its
    // certificate. Reopen can finish this transfer even if that row is gone.
    await operations.publish("acknowledge", publication);
    await operations.acknowledgeReceipt(jobId, publication, record);
    if (record.rejectedAdmission) await operations.discardArtifacts(jobId);
  }
  operations.finish(jobId, publication.released, record.rejectedAdmission === true);
}
