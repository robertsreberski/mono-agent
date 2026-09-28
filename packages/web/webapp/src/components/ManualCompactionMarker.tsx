import { useEffect, useState } from "react";
import type { ThreadDetail, ThreadSummary } from "../types";
import { runningManualCompaction } from "../manual-compaction";
import { isContextCompactionPart } from "../process-job-presentation";

/** Transient only: the final result is rendered from the persisted assistant part. */
export function ManualCompactionMarker({ thread, detail }: {
  readonly thread: ThreadSummary | null; readonly detail: ThreadDetail | null;
}) {
  const runningAt = runningManualCompaction(thread) ? thread!.compaction!.startedAt : undefined;
  const [held, setHeld] = useState<{ readonly threadId: string; readonly at: string } | null>(null);
  useEffect(() => {
    if (thread === null) { setHeld(null); return; }
    if (runningAt !== undefined) { setHeld({ threadId: thread.id, at: runningAt }); return; }
    if (held !== null && held.threadId !== thread.id) { setHeld(null); return; }
    if (held === null) return;
    // message.changed precedes the clear event but its single-message repair is
    // asynchronous. Bridge that read, then expire on an agent error (no result).
    const timeout = window.setTimeout(() => setHeld(null), 3_000);
    return () => window.clearTimeout(timeout);
  }, [thread?.id, runningAt, held?.threadId, held?.at]);
  const pendingAt = runningAt ?? (held !== null && held.threadId === thread?.id ? held.at : undefined);
  if (pendingAt === undefined) return null;
  const startedAt = Date.parse(pendingAt);
  const hasResult = detail !== null && detail.thread.id === thread?.id && detail.messages.some((message) => message.parts.some((part) => {
    if (part.type === "conversation-marker" && part.kind === "compaction")
      return part.trigger === "manual" && Date.parse(part.at) >= startedAt;
    if (message.role !== "assistant") return false;
    if (part.type !== "telemetry" || !isContextCompactionPart(part)) return false;
    const outer = part.data as { data?: { trigger?: unknown; timestamp?: unknown } } | undefined;
    const payload = outer?.data;
    return payload?.trigger === "manual" && typeof payload.timestamp === "number" && payload.timestamp >= startedAt;
  }));
  if (hasResult) return null;
  return <div className="context-compaction-row is-running is-transient" role="note"
    aria-label="Compacting context… · manual">
    <span className="context-compaction-content">Compacting context… · manual</span>
  </div>;
}
