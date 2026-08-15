/** Keep serialized worker operations usable after a terminal response failure. */
export function continueToolHistoryOperationTail(
  tail: Promise<void>,
  operation: () => void | Promise<void>,
): Promise<void> {
  return tail.then(operation).catch(() => undefined);
}
