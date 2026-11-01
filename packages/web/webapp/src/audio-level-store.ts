/** Samples are external to composer/capture state: only the meter subscribes. */
export function createAudioLevelStore() {
  let levels: readonly number[] = [];
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => levels,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    publish: (next: readonly number[]) => { levels = next; listeners.forEach(listener => listener()); },
  };
}
