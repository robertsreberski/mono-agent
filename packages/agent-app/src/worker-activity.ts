import type { AgentResponder } from "@mono-agent/agent-contracts";

export interface WorkerActivityCounts {
  readonly turns: number;
  readonly jobs: number;
  readonly asks: number;
}

/** App-owned, synchronous activity; durable job records are not an execution oracle. */
export class WorkerActivityTracker {
  private counts: WorkerActivityCounts = { turns: 0, jobs: 0, asks: 0 };
  private readonly listeners = new Set<(counts: WorkerActivityCounts) => void>();

  snapshot(): WorkerActivityCounts { return { ...this.counts }; }
  busy(): boolean { return activityBusy(this.counts); }
  set(source: keyof WorkerActivityCounts, count: number): void {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid worker activity count.");
    if (this.counts[source] === count) return;
    this.counts = { ...this.counts, [source]: count };
    for (const listener of this.listeners) listener(this.snapshot());
  }
  /** Each service owns only its contribution, including settlement after reload. */
  jobExecutionObserver(): (count: number) => void {
    let contribution = 0;
    return (count) => {
      if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid worker activity count.");
      const delta = count - contribution;
      contribution = count;
      this.set("jobs", this.counts.jobs + delta);
    };
  }
  subscribe(listener: (counts: WorkerActivityCounts) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  async invocation<T>(operation: () => Promise<T>): Promise<T> {
    this.set("turns", this.counts.turns + 1);
    try { return await operation(); }
    finally { this.set("turns", this.counts.turns - 1); }
  }
}

export function activityBusy(counts: WorkerActivityCounts): boolean {
  return counts.turns + counts.jobs + counts.asks > 0;
}

/** Preserve optional capabilities and their receiver, including synchronous live-input offers. */
export function trackResponderActivity(responder: AgentResponder, tracker: WorkerActivityTracker): AgentResponder {
  return new Proxy(responder, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== "function") return value;
      if (property === "respond" || property === "compactConversation") {
        return (...args: unknown[]) => tracker.invocation(() => Reflect.apply(value, target, args));
      }
      return value.bind(target);
    },
  });
}
