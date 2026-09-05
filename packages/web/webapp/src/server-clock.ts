/**
 * Timestamps the console renders were stamped by the web service's clock, but
 * a live elapsed ticks with the browser's. Any skew between the two would make
 * the live figure drift from the value it freezes at, so the `at` stamp on
 * every SSE event (the `ready` ping included) keeps an estimate of the offset
 * and live arithmetic is done in server time. Module state, like `api`.
 */
let offsetMs = 0;

/** Record one server-stamped ISO timestamp that was received just now. */
export const recordServerTime = (at: unknown, receivedAt = Date.now()): void => {
  if (typeof at !== "string") return;
  const stamped = Date.parse(at);
  if (!Number.isFinite(stamped)) return;
  offsetMs = receivedAt - stamped;
};

/** The current time on the server's clock, as best the console can tell. */
export const serverNow = (): number => Date.now() - offsetMs;

/** Test seam. */
export const resetServerClock = (): void => {
  offsetMs = 0;
};
