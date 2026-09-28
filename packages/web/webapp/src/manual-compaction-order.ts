import type { ThreadSummary, WebMessage } from "./types";
import { isContextCompactionPart } from "./process-job-presentation";
import { runningManualCompaction } from "./manual-compaction";

export function manualCompactionResultTimestamp(message: WebMessage): number | undefined {
  if (message.role !== "assistant") return undefined;
  for (const part of message.parts) {
    if (part.type !== "telemetry" || !isContextCompactionPart(part)) continue;
    const envelope = part.data as { data?: { trigger?: unknown; timestamp?: unknown } } | undefined;
    if (envelope?.data?.trigger === "manual" && typeof envelope.data.timestamp === "number") {
      return envelope.data.timestamp;
    }
  }
  return undefined;
}

/** The last few cleared operations per thread fence equal-revision late reads. */
export function createManualCompactionOrder() {
  const seen = new Map<string, string>();
  const cleared = new Map<string, string[]>();
  const remember = (threadId: string, startedAt: string) => {
    const values = cleared.get(threadId) ?? [];
    cleared.delete(threadId);
    cleared.set(threadId, [...values.filter((value) => value !== startedAt), startedAt].slice(-4));
    if (cleared.size > 256) cleared.delete(cleared.keys().next().value!);
    seen.delete(threadId);
  };
  return {
    accept(thread: ThreadSummary): ThreadSummary {
      const startedAt = runningManualCompaction(thread) ? thread.compaction!.startedAt : undefined;
      if (startedAt === undefined) {
        const previous = seen.get(thread.id);
        if (previous !== undefined) remember(thread.id, previous);
        return thread;
      }
      if (cleared.get(thread.id)?.includes(startedAt)) {
        const { compaction: _stale, ...safe } = thread;
        return safe;
      }
      seen.set(thread.id, startedAt);
      return thread;
    },
    clear(threadId: string, resultTimestamp?: number): boolean {
      const startedAt = seen.get(threadId);
      if (startedAt === undefined || resultTimestamp !== undefined && resultTimestamp < Date.parse(startedAt)) return false;
      remember(threadId, startedAt);
      return true;
    },
    reset(): void { seen.clear(); cleared.clear(); },
  };
}
