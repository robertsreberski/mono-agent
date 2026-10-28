// A narrow invalidation channel: a card can change behind the loaded page.
// The usage endpoint is only read by an open popover, never on the SSE hot path.
const listeners = new Set<(threadId: string, liveUpkeep: boolean) => void>();
export function notifyThreadUsageChanged(threadId: string, liveUpkeep = false): void {
  for (const listener of listeners) listener(threadId, liveUpkeep);
}
export function subscribeThreadUsageChanged(listener: (threadId: string, liveUpkeep: boolean) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
