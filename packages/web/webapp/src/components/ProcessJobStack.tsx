import { type FocusEvent, type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useDocumentVisible } from "../document-visibility";
import { useProcessJobPresentation } from "../process-job-presentation";
import type { ProcessJobProjection } from "../types";
import { Icon } from "./Icon";
import { ProcessJobCard, mergeProcessJobProjection } from "./ProcessJob";
import { ProcessJobGroup } from "./ProcessJobGroup";
import { ProcessJobGlyph, ProcessJobSpinner } from "./ProcessJobGlyph";
import { ProcessJobStackCurrent, type ProcessJobCurrentEntry } from "./ProcessJobStackCurrent";
import { ProcessJobClockProvider, useProcessJobShelfClock } from "./process-job-clock";
import {
  PROCESS_JOB_BUCKETS,
  processJobActiveMark,
  processJobCountWords,
  processJobDisplayState,
  processJobDisplayTitle,
  processJobFinishedWords,
  processJobKind,
  processJobStackAnnouncement,
  type ProcessJobBucket,
  type ProcessJobMark,
  type ProcessJobTone,
} from "./process-job-display";
import {
  processJobGroupPurpose,
  processJobItemJobs,
  processJobItemLead,
  processJobShelfItems,
  processJobShelfPartition,
  type ProcessJobShelfItem,
} from "./process-job-groups";

/** Settled and question chips wear the rows' own glyphs; the active chip reads its rows' state. */
const CHIP_FACE: Readonly<Record<Exclude<ProcessJobBucket, "active">, readonly [ProcessJobTone, ProcessJobMark]>> = {
  question: ["question", "question"],
  issue: ["danger", "cross"],
  cancelled: ["neutral", "stopped"],
  done: ["success", "check"],
};

/**
 * Live projections are keyed by thread AND job: the shelf can outlive a thread
 * switch for a moment (its viewport remounts once the runtime follows the
 * selection), and two conversations may carry the same job id. A projection
 * from one thread must never stand in for another's.
 */
const liveKey = (thread: string | null, jobId: string): string => `${thread ?? ""}\u0000${jobId}`;

/** Hidden by an ancestor's `hidden` attribute, detached, or laid out as nothing. */
const isHidden = (element: HTMLElement): boolean =>
  !element.isConnected || element.closest("[hidden]") !== null;

/**
 * The conversation's background jobs as a compact shelf above the composer.
 *
 * Three tiers, each asked for by the operator: the closed bar is a glance
 * (a glyph-and-number chip per kind of row; the one current item's purpose,
 * or the current items' names while several run), the open shelf lists the
 * current rows purpose-first with finished ones behind History, and an open
 * row shows the detail. Every row counts in exactly one bucket, so the numbers
 * add up to the rows. Every detached child is ONE row: all turns of a subagent
 * instance or of a peer form an agent group whose timeline shows the parent's
 * calls between the child's turns. Nothing opens by itself.
 * Every row stays mounted in ONE keyed sequence, so a settling job moves
 * between current work and History without remounting its poll, its
 * disclosure state or the element under the operator's focus.
 *
 * The bar carries no visible title: its chips and chevron are the control,
 * and its accessible name still starts with "Background jobs".
 */
export function ProcessJobStack() {
  const {
    threadId,
    jobs,
    parentCalls,
    historyIsBounded,
    historyOpen,
    setHistoryOpen,
    shelfOpen,
    setShelfOpen,
  } = useProcessJobPresentation();
  const stackId = useId();
  const visible = useDocumentVisible();
  const sectionRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const historyRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [liveByJobId, setLiveByJobId] = useState<ReadonlyMap<string, ProcessJobProjection>>(
    () => new Map(jobs.map(({ part }) => [liveKey(threadId, part.job.jobId), part.job])),
  );

  useEffect(() => {
    setLiveByJobId((current) => {
      const next = new Map<string, ProcessJobProjection>();
      for (const { part } of jobs) {
        const key = liveKey(threadId, part.job.jobId);
        const live = current.get(key);
        next.set(key, live === undefined ? part.job : mergeProcessJobProjection(live, part.job));
      }
      return next;
    });
  }, [jobs, threadId]);

  const onProjectionChange = useCallback((projection: ProcessJobProjection) => {
    const key = liveKey(threadId, projection.jobId);
    setLiveByJobId((current) => {
      const previous = current.get(key);
      const merged = previous === undefined ? projection : mergeProcessJobProjection(previous, projection);
      if (merged === previous) return current;
      const next = new Map(current);
      next.set(key, merged);
      return next;
    });
  }, [threadId]);

  const projections = useMemo(
    () => jobs.map(({ part }) => liveByJobId.get(liveKey(threadId, part.job.jobId)) ?? part.job),
    [jobs, liveByJobId, threadId],
  );
  const now = useProcessJobShelfClock(projections, visible);

  /**
   * Bring a row the operator just opened into the shelf's own view. Only the
   * shelf body scrolls: never the transcript, never an ancestor.
   */
  const revealRow = useCallback((card: HTMLElement) => {
    window.requestAnimationFrame(() => {
      const body = bodyRef.current;
      if (body === null || !body.contains(card)) return;
      const bodyBox = body.getBoundingClientRect();
      const cardBox = card.getBoundingClientRect();
      const above = cardBox.top - bodyBox.top;
      if (above < 0) {
        body.scrollTop += above;
        return;
      }
      const below = cardBox.bottom - bodyBox.bottom;
      if (below > 0) body.scrollTop += Math.min(below, above);
    });
  }, []);

  /**
   * The element inside this shelf that holds the operator's focus, tracked
   * BEFORE anything hides it. Chromium drops focus from a node that becomes
   * hidden to the page body, so by the time the shelf re-renders
   * `document.activeElement` can no longer say whose focus it was.
   */
  const focusOwner = useRef<HTMLElement | null>(null);
  const trackFocus = useCallback((event: FocusEvent<HTMLElement>) => {
    if (event.target instanceof HTMLElement) focusOwner.current = event.target;
  }, []);
  const releaseFocus = useCallback((event: FocusEvent<HTMLElement>) => {
    const leaving = event.target;
    const next = event.relatedTarget;
    // Focus moved somewhere else on purpose (the composer, the page): forget
    // it. A blur caused by the node becoming hidden keeps its owner.
    if (next instanceof Node && sectionRef.current?.contains(next)) return;
    if (leaving instanceof HTMLElement && isHidden(leaving)) return;
    focusOwner.current = null;
  }, []);

  // A row that settles, or whose question expires, while History is closed
  // becomes hidden. If the operator's focus was in it, hand focus to the
  // nearest visible control of this shelf. Focus that already moved elsewhere
  // (the composer) is never touched.
  useLayoutEffect(() => {
    const owner = focusOwner.current;
    const section = sectionRef.current;
    if (owner === null || section === null || !isHidden(owner)) return;
    const focused = document.activeElement;
    const lost = focused === owner || focused === null || focused === document.body || focused === document.documentElement;
    if (!lost) return;
    const target = historyRef.current !== null && !isHidden(historyRef.current) ? historyRef.current : toggleRef.current;
    if (target === null) return;
    focusOwner.current = target;
    target.focus();
  });

  if (threadId === null || jobs.length === 0) return null;

  const entries = jobs.map(({ part }, index) => ({ part, job: projections[index] ?? part.job }));
  // Items, not jobs: an agent group is one row and one count, whatever its turns.
  const shelf = processJobShelfItems(entries, parentCalls);
  // One partition: every row in exactly one bucket. The chips, History's
  // count and the announcement all read it, so no two numbers overlap.
  const { counts, current, finished, active } = processJobShelfPartition(shelf, now);
  const hasHistory = historyIsBounded || finished.length > 0;
  const singleItem = current.length === 1 ? current[0]! : undefined;
  const single = singleItem === undefined ? undefined : processJobItemLead(singleItem, now);
  const quiet = current.length === 0 && counts.issue === 0;
  const bodyId = `${stackId}-body`;
  const labelId = `${stackId}-label`;
  const historyCountId = `${stackId}-history-count`;

  // One flat keyed sequence: current rows, the History row, the bounded note,
  // then finished rows. Keys never depend on position: a job row is keyed by
  // thread and job, an agent group by thread, family and id, and each turn
  // inside a group keeps its own thread and job key.
  const items: ReactNode[] = [];
  const row = (item: ProcessJobShelfItem, hidden: boolean) => item.kind === "group" ? (
    <div key={`${threadId}:group:${item.key}`} className="process-job-stack-item" hidden={hidden}>
      <ProcessJobGroup
        group={item}
        threadId={threadId}
        onProjectionChange={onProjectionChange}
        onOpen={revealRow}
        shown={shelfOpen && !hidden}
      />
    </div>
  ) : (
    <div key={`${threadId}:${item.entry.job.jobId}`} className="process-job-stack-item" hidden={hidden}>
      <ProcessJobCard
        part={item.entry.part}
        onProjectionChange={onProjectionChange}
        onOpen={revealRow}
        shown={shelfOpen && !hidden}
      />
    </div>
  );
  for (const entry of current) items.push(row(entry, false));
  if (hasHistory) {
    items.push(
      <div key={`${threadId}:history`} className="process-job-stack-history-row">
        <button
          ref={historyRef}
          type="button"
          className="process-job-stack-history-toggle"
          aria-label="Background job history"
          aria-pressed={historyOpen}
          {...(finished.length > 0 ? { "aria-describedby": historyCountId } : {})}
          onClick={() => setHistoryOpen(!historyOpen)}
        >
          <span>History</span>
          {/* How many rows History holds: a bare number on screen, words for assistive tech. */}
          {finished.length > 0 ? <>
            <span className="process-job-stack-history-count" aria-hidden="true">{finished.length}</span>
            <span id={historyCountId} className="sr-only">{processJobFinishedWords(finished.length)}</span>
          </> : null}
          <Icon className="process-job-stack-chevron" name="chevron-down" size={13} />
        </button>
      </div>,
    );
  }
  if (historyIsBounded) {
    // Counts only ever count what is loaded; this says where the rest is.
    items.push(
      <p key={`${threadId}:bounded`} className="process-job-stack-history" hidden={!historyOpen}>
        Older jobs are in earlier messages.
      </p>,
    );
  }
  for (const entry of finished) items.push(row(entry, !historyOpen));

  // One chip per non-empty bucket, in one fixed order, open or closed: a
  // glyph and a number on screen, the words in its tooltip and in the
  // button's accessible name. The glyphs are the rows' own, so they need no
  // words. Only the closed bar's in-progress chip spins; open, it holds still
  // like the rows below it.
  const chip = (bucket: ProcessJobBucket, open: boolean) => {
    const value = counts[bucket];
    const words = processJobCountWords[bucket](value);
    let tone: ProcessJobTone;
    let mark: ReactNode;
    if (bucket === "active") {
      const state = processJobActiveMark(active.flatMap(processJobItemJobs), now);
      tone = state.tone;
      mark = state.spinning && !open ? <ProcessJobSpinner /> : <ProcessJobGlyph small tone={state.tone} mark={state.mark} />;
    } else {
      const [faceTone, faceMark] = CHIP_FACE[bucket];
      tone = faceTone;
      mark = <ProcessJobGlyph small tone={faceTone} mark={faceMark} />;
    }
    return (
      <span key={bucket} className={`process-job-chip is-${tone}`} title={words}>
        <span className="process-job-chip-mark" aria-hidden="true">{mark}</span>
        <span className="process-job-chip-count" aria-hidden="true">{value}</span>
        <span className="sr-only">{words}</span>
      </span>
    );
  };
  const singleState = single === undefined ? undefined : processJobDisplayState(single, now);
  // Closed with one current row, that row's glyph and purpose stand for it,
  // so it takes no in-progress chip. A question is always counted, even when
  // the lone current row's own glyph already says it.
  const showSingle = !shelfOpen && single !== undefined;
  // Closed with two or more current rows, they are listed by name instead of
  // counted: questions first, then work in progress, each in shelf order.
  // Their glyphs say what the question and in-progress chips would.
  const listed: ProcessJobCurrentEntry[] = shelfOpen || current.length < 2 ? [] : [
    ...current.filter((item) => !active.includes(item)),
    ...active,
  ].map((item) => {
    const lead = processJobItemLead(item, now);
    const state = processJobDisplayState(lead, now);
    const asking = !active.includes(item);
    return {
      key: item.key,
      name: item.kind === "group" ? item.instanceId : lead.tool,
      kind: processJobKind(lead),
      tone: asking ? "question" : state.tone,
      mark: asking ? "question" : state.mark,
      word: asking ? "question pending" : state.word.toLowerCase(),
    };
  });
  const chips = PROCESS_JOB_BUCKETS
    .filter((bucket) => counts[bucket] > 0
      && !(showSingle && bucket === "active")
      && !(listed.length > 0 && (bucket === "question" || bucket === "active")))
    .map((bucket) => chip(bucket, shelfOpen));

  return (
    <ProcessJobClockProvider value={now}>
      <section
        ref={sectionRef}
        className={`process-job-stack${shelfOpen ? " is-open" : ""}${quiet ? " is-quiet" : ""}`}
        aria-labelledby={labelId}
        onFocus={trackFocus}
        onBlur={releaseFocus}
      >
        <button
          ref={toggleRef}
          type="button"
          className="process-job-stack-toggle"
          aria-expanded={shelfOpen}
          aria-controls={bodyId}
          onClick={() => setShelfOpen(!shelfOpen)}
        >
          {/* No visible title: the bar is its chips and chevron. The name
              still starts with it, for the region and for assistive tech. */}
          <span id={labelId} className="sr-only">Background jobs</span>
          {/* Closed, one current row shows its glyph, kind and purpose; two or
              more are listed by name. Open, the header keeps only the chips;
              the rows are below. */}
          {!shelfOpen && single !== undefined && singleState !== undefined ? (
            <span className="process-job-stack-single">
              {singleState.mark === "half"
                ? <ProcessJobSpinner />
                : <ProcessJobGlyph small tone={singleState.tone} mark={singleState.mark} />}
              {/* Kind at a glance, as on the row's status line: a terminal or an agent. */}
              <Icon
                className={`process-job-stack-kind is-${processJobKind(single)}`}
                name={processJobKind(single) === "agent" ? "agent" : "terminal"}
                size={14}
              />
              {/* The glyph's state and the icon's kind, in words: "Running Bash job:",
                  or for an agent group "Running agent researcher-1:". */}
              <span className="sr-only">{`${[singleState.word, ...(singleState.pending === undefined ? [] : [singleState.pending])].join(", ")} ${
                singleItem?.kind === "group"
                  ? `${singleItem.family === "peer" ? "peer agent" : "agent"} ${singleItem.instanceId}:`
                  : `${single.tool} job:`}`}</span>
              {singleItem?.kind === "group" ? <span className="process-job-stack-agent" aria-hidden="true">{singleItem.instanceId}</span> : null}
              {/* A group's status is its lead turn's; its title is always the newest task. */}
              <span className="process-job-stack-purpose" title={singleItem?.kind === "group" ? singleItem.newest.summary : single.summary}>
                {singleItem?.kind === "group" ? processJobGroupPurpose(singleItem) : processJobDisplayTitle(single)}
              </span>
            </span>
          ) : null}
          {listed.length > 0 ? <ProcessJobStackCurrent entries={listed} trailing={chips.length > 0} /> : null}
          {chips.length > 0 ? <span className="process-job-stack-chips">{chips}</span> : null}
          <Icon className="process-job-stack-chevron" name="chevron-down" size={15} />
        </button>
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {processJobStackAnnouncement(counts)}
        </span>
        <div ref={bodyRef} id={bodyId} className="process-job-stack-body" hidden={!shelfOpen}>
          <div className="process-job-stack-list">{items}</div>
        </div>
      </section>
    </ProcessJobClockProvider>
  );
}
