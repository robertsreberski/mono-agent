/** Minimal shared serialization seam for config reload, shutdown, and memory mutations. */
export interface AppOperationTail {
  configApplyTail: Promise<void>;
}

export async function serializeAppOperation<T>(
  controller: AppOperationTail,
  operation: () => Promise<T>,
): Promise<T> {
  const next = controller.configApplyTail.then(operation, operation);
  controller.configApplyTail = next.then(
    () => undefined,
    () => undefined,
  );
  return await next;
}
