import type { PeerProcessJobQuestion } from "@mono-agent/agent-contracts";
import type { ManagedSubagentAdmission, ManagedSubagentExecution } from "./subagent-managed-turn.js";
import type { SubagentProgressEvent } from "./process-job-subagent-progress.js";
import type { ProcessJobProcessResult, ProcessJobStartResult } from "@mono-agent/runtime-adapter";

/** App-private closure lane. Only the safe identity and lifecycle enter the store. */
export interface InternalProcessJobRequest {
  readonly kind: "internal";
  readonly managed?: ManagedSubagentAdmission;
  readonly tool: "Agent" | "AgentManage" | "PeerAgent";
  readonly jobId: string;
  readonly instanceId: string;
  readonly timeoutMs?: number;
  readonly description?: string;
  readonly maxOutputChars?: number;
  readonly wakeOnCompletion?: boolean;
  readonly prepared?: never;
  readonly launch?: never;
  /** Argument three receives progress events; execution metadata stays additive in argument four. */
  run(signal: AbortSignal, writeOutput: (text: string) => void, reportProgress: (event: SubagentProgressEvent) => void, execution?: { deadlineAt: number; managed?: ManagedSubagentExecution }): Promise<{ answer?: string; output: string; status: string; childStillBusy?: boolean; question?: { question: string; options?: string[] }; peerQuestion?: PeerProcessJobQuestion }>;
  /** Releases only this job's unstarted reservation; idempotent after begin. */
  cleanup(): Promise<void>;
  /** Called when the settled result could not be persisted (and so will not wake). */
  onSettlementFailure?(): void;
}

export interface SubagentStopIdentity { readonly instanceId: string; readonly instanceIncarnation: string; readonly turnToken: string }
export interface SubagentStopProof {
  readonly jobId: string;
  readonly stopRequested: boolean;
  readonly childStillBusy: boolean;
  readonly resumable: boolean;
  readonly disposition: string | null;
}
/** Delivery is an observation of this offer only, never a claim about the child's answer. */
export interface SubagentSteerProof {
  readonly jobId: string;
  readonly delivery: "consumed" | "offered" | "rejected" | "unsupported";
  readonly reason?: string;
}
export interface InternalProcessJobsController {
  stop?(identity: SubagentStopIdentity): Promise<SubagentStopProof>;
  steer?(identity: SubagentStopIdentity, text: string): Promise<SubagentSteerProof>;
  readonly managed?: boolean;
  startInternal(request: InternalProcessJobRequest): Promise<ProcessJobStartResult>;
}

export type InternalProcessJobResult = ProcessJobProcessResult & { readonly answer?: string; readonly childStillBusy?: boolean; readonly question?: { question: string; options?: string[] }; readonly peerQuestion?: PeerProcessJobQuestion };

/** Reporting is bounded; the actual child owns its separate true-settlement lease. */
export function launchInternalProcessJob(
  request: InternalProcessJobRequest,
  timeoutMs: number,
  maxOutputBytes: number,
  graceMs = 5_100,
  onOutput?: (chunk: Buffer) => void,
  onProgress?: (event: SubagentProgressEvent) => void,
  deadlineAt = Date.now() + timeoutMs,
  managed?: ManagedSubagentExecution,
): { cancel(): void; completion: Promise<InternalProcessJobResult> } {
  const controller = new AbortController();
  const start = Date.now();
  let timedOut = false;
  let grace: ReturnType<typeof setTimeout> | undefined;
  let finish!: (value: { answer?: string; output: string; status: string; childStillBusy?: boolean; question?: { question: string; options?: string[] }; peerQuestion?: PeerProcessJobQuestion }) => void;
  let settled = false;
  const chunks: Buffer[] = [];
  let storedBytes = 0;
  let totalBytes = 0;
  const writeOutput = (text: string): void => {
    if (settled) return;
    totalBytes += Buffer.byteLength(text);
    const bounded = Buffer.from(text.slice(0, Math.max(0, maxOutputBytes - storedBytes)), "utf8")
      .subarray(0, Math.max(0, maxOutputBytes - storedBytes));
    if (bounded.length > 0) { chunks.push(bounded); storedBytes += bounded.length; onOutput?.(bounded); }
  };
  const cancel = (): void => {
    if (settled || controller.signal.aborted) return;
    clearTimeout(timer);
    controller.abort(timedOut ? new DOMException("Process-job runtime deadline exceeded", "TimeoutError") : undefined);
    grace = setTimeout(() => finish({ output: "", status: timedOut ? "timeout" : "cancelled", childStillBusy: true }), graceMs);
  };
  const timer = setTimeout(() => { timedOut = true; cancel(); }, Math.max(1, deadlineAt - Date.now()));
  const completion = new Promise<InternalProcessJobResult>((resolve) => {
    finish = (value) => {
      if (settled) return;
      writeOutput(value.output);
      settled = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      const childStillBusy = value.childStillBusy === true;
      const raw = Buffer.concat(chunks);
      const stdout = raw.subarray(0, maxOutputBytes).toString("utf8").replace(/�$/u, "");
      const bytes = Buffer.byteLength(stdout);
      resolve({ code: ["ok", "awaiting_reply"].includes(value.status) ? 0 : 1,
        signal: null, stdout, stderr: "", aborted: controller.signal.aborted && !timedOut,
        timedOut: timedOut || value.status === "timeout", bufferExceeded: false,
        truncated: totalBytes > maxOutputBytes, bytes: totalBytes, storedBytes: bytes,
        ...(value.answer === undefined ? {} : { answer: value.answer }),
        spawnError: null, durationMs: Date.now() - start, childStillBusy,
        ...(value.status === "awaiting_reply" && value.question ? { question: value.question } : {}),
        ...(value.status === "awaiting_reply" && value.peerQuestion ? { peerQuestion: value.peerQuestion } : {}) });
    };
  });
  // The caller has durably published running and active ownership before this microtask.
  void Promise.resolve().then(() => request.run(controller.signal, writeOutput, (event) => { if (!settled) onProgress?.(event); }, { deadlineAt, ...(managed ? { managed } : {}) })).then(finish)
    .catch(() => finish({ output: "Subagent execution failed.", status: "failed" }));
  return { cancel, completion };
}
