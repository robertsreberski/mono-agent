// A narrow invalidation channel: a card can change behind the loaded page.
// The usage endpoint is only read by an open popover, never on the SSE hot path.
const listeners = new Set<(threadId: string) => void>();
export function notifyThreadUsageChanged(threadId: string): void {
  for (const listener of listeners) listener(threadId);
}
export function subscribeThreadUsageChanged(listener: (threadId: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
