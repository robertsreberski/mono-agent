import { createContext, useContext, useEffect, useState } from "react";

import { serverNow } from "../server-clock";
import type { ProcessJobProjection } from "../types";
import { nextPeerQuestionDeadline } from "./process-job-display";

/**
 * The shelf's one clock snapshot. Counts, row order and every row's labels read
 * the same instant, so a question cannot be "pending" in the header and
 * "expired" in its row. Cards outside a shelf read the server clock directly.
 */
const ProcessJobClockContext = createContext<number | undefined>(undefined);

export const ProcessJobClockProvider = ProcessJobClockContext.Provider;

export const useProcessJobNow = (): number => useContext(ProcessJobClockContext) ?? serverNow();

/** How stale a pending question's "expires in" wording may get between data changes. */
const QUESTION_LABEL_REFRESH_MS = 30_000;

/**
 * A snapshot that moves only when something it decides can change: the jobs
 * change, the tab becomes visible again, a pending question reaches its
 * deadline, or (while one is pending) its wording needs refreshing. Nothing
 * here polls a server: terminal cards stay silent.
 */
export function useProcessJobShelfClock(jobs: readonly ProcessJobProjection[], visible: boolean): number {
  const [now, setNow] = useState(serverNow);

  useEffect(() => {
    if (visible) setNow(serverNow());
  }, [jobs, visible]);

  useEffect(() => {
    if (!visible) return;
    const deadline = nextPeerQuestionDeadline(jobs, now);
    if (deadline === undefined) return;
    const delay = Math.min(Math.max(deadline - now + 25, 25), QUESTION_LABEL_REFRESH_MS);
    const timer = window.setTimeout(() => setNow(serverNow()), delay);
    return () => window.clearTimeout(timer);
  }, [jobs, now, visible]);

  return now;
}
