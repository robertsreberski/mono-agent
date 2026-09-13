import { retainSubagentCommandReceipt, subagentCommandReceipt, type SubagentCommandReceipts } from "./subagent-command-receipts.js";
import { randomUUID } from "node:crypto";
import type { OwnedForegroundProcessRequest, OwnedForegroundProcesses, ProcessJobProcessHandle, ProcessJobProcessResult } from "@mono-agent/runtime-adapter";
import type { ProcessIncarnation } from "./process-incarnation.js";
import { SUBAGENT_SEEN_CALLS_MAX_BYTES, SUBAGENT_SEEN_CALLS_MAX_COUNT, type SubagentExecutionOwnership } from "./subagent-execution-ownership.js";

export interface SubagentOwnedCommandsPort {
  readonly deadlineAt: number;
  readonly maxOutputBytes: number;
  now(): number;
  /** Service serialization; only mutate the matching immutable job/turn. */
  mutate(operation: (ownership: SubagentExecutionOwnership, receipts: SubagentCommandReceipts) => void): Promise<void>;
  readIncarnation(pid: number): Promise<ProcessIncarnation | undefined>;
  /** Runs outside service mutation serialization. */
  changed(): Promise<void>;
}

/** One borrowed command slot, no queue or fallback, no model-selected owner identity. */
export function createSubagentOwnedCommands(port: SubagentOwnedCommandsPort): {
  readonly processes: OwnedForegroundProcesses;
  revoke(): void;
} {
  const abort = new AbortController();
  let attempt = 0;
  let inFlight = false;
  const revoke = (): void => { abort.abort(); };
  return { revoke, processes: Object.freeze({
    forAttempt() {
      if (abort.signal.aborted || !Number.isSafeInteger(attempt + 1)) throw new Error("Subagent command owner is revoked.");
      const ordinal = ++attempt;
      return Object.freeze({ run: async (request: OwnedForegroundProcessRequest): Promise<ProcessJobProcessResult> => {
        if (inFlight || abort.signal.aborted) {
          await request.prepared.cleanup?.();
          throw new Error("Subagent owned command slot is unavailable.");
        }
        inFlight = true;
        const id = randomUUID();
        const key = `${ordinal}:${request.callId}`;
        let admitted = false;
        let handle: ProcessJobProcessHandle | undefined;
        let result: ProcessJobProcessResult | undefined;
        let cleaned = false;
        const cleanup = async (): Promise<void> => {
          if (!cleaned) { await request.prepared.cleanup?.(); cleaned = true; }
        };
        try {
          const remaining = Math.min(request.timeoutMs, port.deadlineAt - port.now());
          if (!Number.isSafeInteger(remaining) || remaining < 1 || request.signal?.aborted) throw new Error("Subagent command deadline expired.");
          await port.mutate((owner) => {
            if (owner.revoked || owner.owner.settlement !== "running" || (owner.command && owner.command.state !== "released")) throw new Error("Subagent command ownership remains unresolved.");
            if (owner.seenCalls.includes(key)) throw new Error("Subagent command call was already executed.");
            if (owner.seenCalls.length >= SUBAGENT_SEEN_CALLS_MAX_COUNT
              || Buffer.byteLength(JSON.stringify([...owner.seenCalls, key])) > SUBAGENT_SEEN_CALLS_MAX_BYTES) throw new Error("Subagent command identity capacity exceeded.");
            owner.seenCalls.push(key);
            owner.command = { id, callKey: key, tool: request.tool, state: "preparing", cwd: request.prepared.cwd,
              sandboxSettingsPath: request.prepared.sandboxSettingsPath ?? null,
              pid: null, pgid: null, incarnation: null, budgetMs: remaining, deadlineAt: port.now() + remaining };
          });
          admitted = true;
          const signal = request.signal ? AbortSignal.any([abort.signal, request.signal]) : abort.signal;
          if (signal.aborted) throw new Error("Subagent command was revoked before launch.");
          handle = request.launch({ timeoutMs: remaining, signal, maxBufferBytes: port.maxOutputBytes });
          if (!Number.isSafeInteger(handle.pid) || handle.pid === null || handle.pid <= 0 || handle.pgid !== handle.pid
            || typeof handle.release !== "function" || typeof handle.cancel !== "function" || !handle.completion) throw new Error("Subagent command gate identity is unavailable.");
          const incarnation = await port.readIncarnation(handle.pid);
          if (!incarnation) throw new Error("Subagent command incarnation is unavailable.");
          const pid = handle.pid;
          await port.mutate((owner) => {
            if (owner.revoked || owner.command?.id !== id || signal.aborted) throw new Error("Subagent command gate was revoked.");
            Object.assign(owner.command, { pid, pgid: pid, incarnation, state: "attested" });
          });
          // Durable release fence precedes releasing the exact one-shot target.
          await port.mutate((owner) => {
            if (owner.revoked || owner.command?.id !== id || signal.aborted || port.now() >= port.deadlineAt) throw new Error("Subagent command release was revoked.");
            owner.command.state = "running";
          });
          await handle.release();
          result = await handle.completion;
          if (result.groupExitConfirmed !== true) throw new Error("Subagent command group cleanup remains unresolved.");
          await cleanup();
          await port.mutate((owner, receipts) => {
            if (owner.command?.id !== id) throw new Error("Subagent command identity changed.");
            owner.command.state = "released";
            retainSubagentCommandReceipt(receipts, subagentCommandReceipt(owner.command, port.now(), result));
          });
          await port.changed();
          return result;
        } catch (error) {
          if (handle) {
            handle.cancel();
            result ??= await handle.completion.catch(() => undefined);
          }
          // No target before launch, or actual group-settlement proof afterwards.
          if (!handle || result?.groupExitConfirmed === true) await cleanup().catch(() => undefined);
          if (admitted) {
            await port.mutate((owner, receipts) => {
              if (owner.command?.id !== id) throw new Error("Subagent command identity changed.");
              owner.command.state = cleaned ? "released" : "cleanup_unknown";
              owner.revoked = true;
              retainSubagentCommandReceipt(receipts, subagentCommandReceipt(owner.command, port.now(), result));
            }).catch(() => undefined); // A failed durable write retains the earlier ownership fence.
            revoke();
            await port.changed().catch(() => undefined);
          }
          throw error;
        } finally { inFlight = false; }
      } });
    },
  }) };
}
