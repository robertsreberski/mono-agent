/**
 * Timestamps the console renders were stamped by the web service's clock, but
 * a live elapsed ticks with the browser's. Any skew between the two would make
 * the live figure drift from the value it freezes at, so the `at` stamp on
 * every SSE event (the `ready` ping included) keeps an estimate of the offset
 * and live arithmetic is done in server time. Module state, like `api`.
 *
 * The estimate includes the frame's one-way delivery delay, which reads as the
 * browser running that much ahead. The header shows whole seconds and a frame
 * crosses the tailnet in milliseconds, so that is noise; and the latest sample
 * always wins, so a clock step on either side heals on the next event, where
 * a minimum-latency filter would hold a stale offset until reload. The frozen
 * figure never uses this at all: it comes from two server stamps.
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
