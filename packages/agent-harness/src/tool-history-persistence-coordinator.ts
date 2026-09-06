export type ToolHistoryRequestSettlement<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected"; readonly error: unknown };

export type ToolHistoryForegroundSettlement<T> =
  | { readonly status: "settled"; readonly settlement: ToolHistoryRequestSettlement<T> }
  | { readonly status: "deferred" };

type TrackedSettlement = Promise<ToolHistoryRequestSettlement<unknown>>;

/**
 * Tracks accepted lifecycle requests after the foreground stream wait ends.
 * The class is internal: persistence receipts remain the package boundary.
 */
export class ToolHistoryPersistenceCoordinator {
  private readonly byRun = new Map<string, Set<TrackedSettlement>>();
  private readonly all = new Set<TrackedSettlement>();

  constructor(private readonly foregroundCeilingMs: number) {}

  async track<T>(
    runKey: string,
    completion: Promise<T>,
    onSettled?: (settlement: ToolHistoryRequestSettlement<T>) => void,
  ): Promise<ToolHistoryForegroundSettlement<T>> {
    const settlement: Promise<ToolHistoryRequestSettlement<T>> = completion.then(
      (value): ToolHistoryRequestSettlement<T> => ({ status: "fulfilled", value }),
      (error: unknown): ToolHistoryRequestSettlement<T> => ({ status: "rejected", error }),
    );
    let tracked: Promise<ToolHistoryRequestSettlement<T>>;
    tracked = settlement.then((value) => {
      try { onSettled?.(value); } catch { /* diagnostics must not change settlement */ }
      return value;
    }).finally(() => {
      this.all.delete(tracked as TrackedSettlement);
      const pending = this.byRun.get(runKey);
      pending?.delete(tracked as TrackedSettlement);
      if (pending?.size === 0) this.byRun.delete(runKey);
    });
    let pending = this.byRun.get(runKey);
    if (pending === undefined) {
      pending = new Set();
      this.byRun.set(runKey, pending);
    }
    pending.add(tracked as TrackedSettlement);
    this.all.add(tracked as TrackedSettlement);
    return await foregroundSettlement(tracked, this.foregroundCeilingMs);
  }

  boundaryForRun(runKey: string): readonly TrackedSettlement[] {
    return [...(this.byRun.get(runKey) ?? [])];
  }

  boundaryForAll(): readonly TrackedSettlement[] {
    return [...this.all];
  }

  pendingForRun(runKey: string): number {
    return this.byRun.get(runKey)?.size ?? 0;
  }

  async waitForBoundary(
    boundary: readonly Promise<unknown>[],
    timeoutMs: number,
  ): Promise<boolean> {
    if (boundary.length === 0) return true;
    return await new Promise<boolean>((resolve) => {
      let finished = false;
      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
      void Promise.allSettled(boundary).then(() => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

async function foregroundSettlement<T>(
  settlement: Promise<ToolHistoryRequestSettlement<T>>,
  timeoutMs: number,
): Promise<ToolHistoryForegroundSettlement<T>> {
  return await new Promise<ToolHistoryForegroundSettlement<T>>((resolve) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      resolve({ status: "deferred" });
    }, timeoutMs);
    timer.unref?.();
    void settlement.then((value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ status: "settled", settlement: value });
    });
  });
}
