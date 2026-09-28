import { type FocusEvent, type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useDocumentVisible } from "../document-visibility";
import { useProcessJobPresentation } from "../process-job-presentation";
import type { ProcessJobProjection } from "../types";
import { Icon } from "./Icon";
import { ProcessJobCard, mergeProcessJobProjection } from "./ProcessJob";
import { ProcessJobGlyph, ProcessJobSpinner } from "./ProcessJobGlyph";
import { ProcessJobClockProvider, useProcessJobShelfClock } from "./process-job-clock";
import {
  processJobActiveMark,
  processJobCountWords,
  processJobDisplayState,
  processJobDisplayTitle,
  processJobIsCurrent,
  processJobKind,
  processJobStackAnnouncement,
  processJobStackCounts,
  processJobStackSummaryParts,
} from "./process-job-display";

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
 * (counts as marked chips, or the one job's purpose), the open shelf lists the
 * current rows purpose-first with finished jobs behind History, and an open row
 * shows the detail. Nothing opens by itself. Every card stays mounted in ONE
 * keyed sequence, so a settling job moves between groups without remounting
 * its poll, its disclosure state or the element under the operator's focus.
 */
export function ProcessJobStack() {
  const {
    threadId,
    jobs,
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
  const current = entries.filter(({ job }) => processJobIsCurrent(job, now));
  const finished = entries.filter(({ job }) => !processJobIsCurrent(job, now));
  const counts = processJobStackCounts(projections, now);
  const summaryParts = processJobStackSummaryParts(counts, historyIsBounded);
  const hasHistory = historyIsBounded || finished.length > 0;
  const single = current.length === 1 ? current[0]!.job : undefined;
  const quiet = current.length === 0 && counts.issues === 0;
  const bodyId = `${stackId}-body`;
  const labelId = `${stackId}-label`;

  // One flat keyed sequence: current rows, the History row, the bounded note,
  // then finished rows. Keys never depend on position or group. With nothing
  // current, the legend above already says "No active jobs".
  const items: ReactNode[] = [];
  const row = ({ part }: (typeof entries)[number], hidden: boolean) => (
    <div key={`${threadId}:${part.job.jobId}`} className="process-job-stack-item" hidden={hidden}>
      <ProcessJobCard
        part={part}
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
          onClick={() => setHistoryOpen(!historyOpen)}
        >
          <span>History</span>
          <Icon className="process-job-stack-chevron" name="chevron-down" size={13} />
        </button>
        {finished.length > 0 ? (
          <span className="process-job-stack-history-count">
            {processJobCountWords.finished(finished.length, historyIsBounded)}
          </span>
        ) : null}
      </div>,
    );
  }
  if (historyIsBounded) {
    items.push(
      <p key={`${threadId}:bounded`} className="process-job-stack-history" hidden={!historyOpen}>
        Showing jobs in loaded messages. Load earlier messages to reveal older jobs.
      </p>,
    );
  }
  for (const entry of finished) items.push(row(entry, !historyOpen));

  // The closed bar: marked counts are always paired with a readable number,
  // the words live in the button's accessible name and in the open shelf.
  const chip = (key: string, tone: string, mark: ReactNode, value: number, words: string) => (
    <span key={key} className={`process-job-chip is-${tone}`} title={words}>
      <span className="process-job-chip-mark" aria-hidden="true">{mark}</span>
      <span className="process-job-chip-count" aria-hidden="true">{value}</span>
      <span className="sr-only">{words}</span>
    </span>
  );
  const singleState = single === undefined ? undefined : processJobDisplayState(single, now);
  // A lone current row names its own question only when its state word IS the
  // question; a failed or cancelled peer with an open question keeps its
  // outcome, so the question chip must still say it.
  const singleSaysQuestion = singleState?.tone === "question";
  const chips: ReactNode[] = [];
  if (single === undefined && counts.active > 0) {
    // The bar's one spinner turns while any of these jobs is in progress.
    const active = processJobActiveMark(projections, now);
    chips.push(chip("active", active.tone, active.spinning ? <ProcessJobSpinner /> : <ProcessJobGlyph small tone={active.tone} mark={active.mark} />,
      counts.active, processJobCountWords.active(counts.active)));
  }
  if (!singleSaysQuestion && counts.questions > 0) {
    chips.push(chip("questions", "question", <ProcessJobGlyph small tone="question" mark="question" />, counts.questions, processJobCountWords.questions(counts.questions)));
  }
  if (counts.issues > 0) {
    chips.push(chip("issues", "danger", <Icon name="alert" size={12} strokeWidth={2.2} />, counts.issues, processJobCountWords.issues(counts.issues)));
  }
  if (current.length === 0 && counts.finished > 0) {
    chips.push(chip("finished", "neutral", <Icon name="restore" size={12} strokeWidth={2} />, counts.finished, processJobCountWords.finished(counts.finished, historyIsBounded)));
  }

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
          <span id={labelId} className="process-job-stack-title">Background jobs</span>
          {single !== undefined && singleState !== undefined ? (
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
              {/* The glyph's state and the icon's kind, in words: "Running Bash job:". */}
              <span className="sr-only">{`${[singleState.word, ...(singleState.pending === undefined ? [] : [singleState.pending])].join(", ")} ${single.tool} job:`}</span>
              <span className="process-job-stack-purpose" title={single.summary}>{processJobDisplayTitle(single)}</span>
            </span>
          ) : null}
          {chips.length > 0 ? <span className="process-job-stack-chips">{chips}</span> : null}
          <Icon className="process-job-stack-chevron" name="chevron-down" size={15} />
        </button>
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {processJobStackAnnouncement(counts, historyIsBounded)}
        </span>
        <div ref={bodyRef} id={bodyId} className="process-job-stack-body" hidden={!shelfOpen}>
          <p className="process-job-stack-legend">{summaryParts.join(" · ")}</p>
          <div className="process-job-stack-list">{items}</div>
        </div>
      </section>
    </ProcessJobClockProvider>
  );
}
