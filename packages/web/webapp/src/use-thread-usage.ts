import { useEffect, useState } from "react";
import type { WebThreadUsage } from "../../src/contracts.js";
import { api } from "./api";
import { subscribeThreadUsageChanged } from "./thread-usage-events";
import type { ThreadDetail } from "./types";
import { windowUsage } from "./usage";

const retained = new Map<string, WebThreadUsage>();
const RETAINED_LIMIT = 20;
function remember(threadId: string, usage: WebThreadUsage) {
  retained.delete(threadId);
  retained.set(threadId, usage);
  if (retained.size > RETAINED_LIMIT) retained.delete(retained.keys().next().value!);
}

/** On-demand conversation-wide accounting; never fetch on a closed popover. */
export function useThreadUsage(threadId: string | undefined, open: boolean, running: boolean, detail?: ThreadDetail | null) {
  const [state, setState] = useState<{ threadId?: string; usage?: WebThreadUsage; loading: boolean; error: boolean }>(
    { loading: false, error: false },
  );
  useEffect(() => {
    if (!open || threadId === undefined) return;
    let active = true;
    let sequence = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let placeholderTimer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const cached = retained.get(threadId);
    setState({ threadId, ...(cached === undefined ? {} : { usage: cached }), loading: cached === undefined, error: false });
    if (cached === undefined) placeholderTimer = setTimeout(() => {
      if (!active) return;
      setState((previous) => previous.threadId !== threadId || !previous.loading ? previous : {
        threadId, ...(detail === undefined || detail === null ? {} : { usage: windowUsage(detail) }),
        loading: false, error: true,
      });
    }, 1_500);
    const load = async () => {
      const request = ++sequence;
      try {
        const usage = await api.threadUsage(threadId, controller.signal);
        if (!active || sequence !== request) return;
        remember(threadId, usage);
        setState({ threadId, usage, loading: false, error: false });
      } catch {
        if (!active || sequence !== request) return;
        // A read failure does not erase a last-good full-conversation result.
        const lastGood = retained.get(threadId);
        setState({ threadId, ...(lastGood !== undefined ? { usage: lastGood }
          : detail === undefined || detail === null ? {} : { usage: windowUsage(detail) }), loading: false, error: true });
      }
    };
    void load();
    const unsubscribe = subscribeThreadUsageChanged((changedThreadId) => {
      if (changedThreadId !== threadId || running) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => { void load(); }, 300);
    });
    return () => { active = false; controller.abort(); unsubscribe(); if (timer !== undefined) clearTimeout(timer); if (placeholderTimer !== undefined) clearTimeout(placeholderTimer); };
  }, [threadId, open, running]);
  // A new thread must never flash the previous thread's figures before its effect runs.
  return { usage: state.threadId === threadId ? state.usage : undefined,
    loading: state.threadId === threadId ? state.loading : open && threadId !== undefined,
    error: state.threadId === threadId && state.error };
}
