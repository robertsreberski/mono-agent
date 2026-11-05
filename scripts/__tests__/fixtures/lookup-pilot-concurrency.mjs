import { availableParallelism } from "node:os";

export const pilotConcurrencyLimit = (cores = availableParallelism()) => Math.max(1, Math.floor(cores / 2));

// Holds admission through cleanup, not just through the test callback. Queued
// tests cancelled by Vitest's timeout must never start actors after teardown.
export function pilotSemaphore(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("fixture_concurrency_invalid");
  const queue = []; let active = 0;
  function drain() {
    while (active < limit && queue.length) {
      const ticket = queue.shift(); if (ticket.done) continue;
      ticket.held = true; active++; ticket.resolve(true);
    }
  }
  return { enter() {
    const ticket = {held: false, done: false};
    const ready = new Promise(resolve => { ticket.resolve = resolve; });
    queue.push(ticket); drain();
    return { ready,
      cancel() { if (!ticket.held && !ticket.done) { ticket.done = true; ticket.resolve(false); } },
      release() {
        if (ticket.done) return;
        ticket.done = true;
        if (ticket.held) active--; else ticket.resolve(false);
        drain();
      },
    };
  } };
}
