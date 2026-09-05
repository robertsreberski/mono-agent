import { useEffect, useState } from "react";
import { serverNow } from "../../server-clock";
import { formatElapsed } from "../duration";

/** The turn's wall-clock window, in server-clock epoch milliseconds. */
export interface ActivityTiming {
  readonly startedAt: number;
  /** Absent until the turn reaches a terminal state. */
  readonly finishedAt?: number;
}

const TICK_MS = 1_000;

/**
 * The header's elapsed figure. A settled window renders once from its two
 * server stamps; an open one ticks once a second, in server time, for as long
 * as the message runs. Not running and no finish stamp means the console
 * cannot know how long the turn took, so it says nothing rather than guess.
 * Its own component so the tick re-renders this span and nothing above it.
 */
export function ActivityElapsed({
  timing,
  live,
  leading = false,
}: {
  readonly timing: ActivityTiming;
  readonly live: boolean;
  /** Separate the figure from a step count that precedes it. */
  readonly leading?: boolean;
}) {
  const ticking = live && timing.finishedAt === undefined;
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    if (!ticking) return;
    setNow(serverNow());
    const id = window.setInterval(() => setNow(serverNow()), TICK_MS);
    return () => window.clearInterval(id);
  }, [ticking]);
  const end = timing.finishedAt ?? (ticking ? now : undefined);
  if (end === undefined) return null;
  return (
    <span className="activity-elapsed">
      {leading ? " \u00b7 " : ""}
      {formatElapsed(end - timing.startedAt)}
    </span>
  );
}
