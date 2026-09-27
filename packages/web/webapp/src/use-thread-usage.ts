import { useEffect, useRef, useState } from "react";
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

type State = { readonly threadId?: string; readonly usage?: WebThreadUsage; readonly loading: boolean;
  readonly error: boolean; readonly fallback: boolean };

/** On-demand conversation-wide accounting; never fetch on a closed popover. */
export function useThreadUsage(threadId: string | undefined, open: boolean, running: boolean, detail?: ThreadDetail | null) {
  const [state, setState] = useState<State>({ loading: false, error: false, fallback: false });
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const runningRef = useRef(running);
  runningRef.current = running;
  const scheduleRef = useRef<(() => void) | null>(null);
  const previousRun = useRef<{ threadId?: string; running: boolean } | null>(null);

  useEffect(() => {
    if (!open || threadId === undefined) return;
    let active = true;
    let sequence = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let placeholderTimer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const cached = retained.get(threadId);
    setState({ threadId, ...(cached === undefined ? {} : { usage: cached }),
      loading: cached === undefined, error: false, fallback: false });
    const fallback = (): State => {
      const lastGood = retained.get(threadId);
      const latest = detailRef.current;
      return { threadId, ...(lastGood !== undefined ? { usage: lastGood }
        : latest === undefined || latest === null ? {} : { usage: windowUsage(latest) }),
        loading: false, error: true, fallback: lastGood === undefined };
    };
    if (cached === undefined) placeholderTimer = setTimeout(() => {
      if (!active) return;
      setState((previous) => previous.threadId !== threadId || !previous.loading ? previous : fallback());
    }, 1_500);
    const load = async () => {
      const request = ++sequence;
      try {
        const usage = await api.threadUsage(threadId, controller.signal);
        if (!active || sequence !== request) return;
        remember(threadId, usage);
        setState({ threadId, usage, loading: false, error: false, fallback: false });
      } catch {
        if (!active || sequence !== request) return;
        setState(fallback());
      }
    };
    const schedule = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => { void load(); }, 300);
    };
    scheduleRef.current = schedule;
    void load();
    const unsubscribe = subscribeThreadUsageChanged((changedThreadId) => {
      if (changedThreadId === threadId && !runningRef.current) schedule();
    });
    return () => {
      active = false; controller.abort(); unsubscribe(); scheduleRef.current = null;
      if (timer !== undefined) clearTimeout(timer);
      if (placeholderTimer !== undefined) clearTimeout(placeholderTimer);
    };
  }, [threadId, open]);

  useEffect(() => {
    if (!open || threadId === undefined) { previousRun.current = null; return; }
    const previous = previousRun.current;
    previousRun.current = { threadId, running };
    if (previous?.threadId === threadId && previous.running && !running) scheduleRef.current?.();
  }, [threadId, open, running]);

  // The loaded message window may grow after a failed endpoint read. Refresh only
  // the fallback; never turn an authoritative cached full-thread answer into it.
  useEffect(() => {
    if (!open || threadId === undefined || detail === undefined || detail === null) return;
    setState((previous) => previous.threadId === threadId && previous.fallback && retained.get(threadId) === undefined
      ? { ...previous, usage: windowUsage(detail) } : previous);
  }, [detail, open, threadId]);

  const cached = threadId === undefined ? undefined : retained.get(threadId);
  return { usage: state.threadId === threadId ? state.usage : cached,
    loading: state.threadId === threadId ? state.loading : open && threadId !== undefined && cached === undefined,
    error: state.threadId === threadId && state.error };
}
