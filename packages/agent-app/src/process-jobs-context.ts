import { AsyncLocalStorage } from "node:async_hooks";

export interface ProcessJobWakeContext {
  readonly jobId: string;
  readonly chainDepth: number;
}

const wakeContext = new AsyncLocalStorage<ProcessJobWakeContext>();

/** Run a genuine channel turn with host-owned fan-out depth attached out of band. */
export async function runWithProcessJobWakeContext<T>(
  context: ProcessJobWakeContext,
  operation: () => Promise<T>,
): Promise<T> {
  return await wakeContext.run(context, operation);
}

/** Current host wake context; model/request metadata cannot populate this value. */
export function currentProcessJobWakeContext(): ProcessJobWakeContext | undefined {
  return wakeContext.getStore();
}
