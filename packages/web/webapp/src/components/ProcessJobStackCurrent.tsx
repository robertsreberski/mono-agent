import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { ProcessJobGlyph, ProcessJobSpinner } from "./ProcessJobGlyph";
import { processJobFitCount, type ProcessJobKind, type ProcessJobMark, type ProcessJobTone } from "./process-job-display";

/** One current row as the closed bar names it: its status and a short name, never its task title. */
export interface ProcessJobCurrentEntry {
  readonly key: string;
  /** An agent's or peer's id; a command job has none, so its tool (`Bash`, `Exec`). */
  readonly name: string;
  readonly kind: ProcessJobKind;
  readonly tone: ProcessJobTone;
  readonly mark: ProcessJobMark;
  /** The state in words, lower case: "running", "queued", "question pending". */
  readonly word: string;
}

function Entry({ entry, first, spinning }: {
  readonly entry: ProcessJobCurrentEntry;
  readonly first: boolean;
  readonly spinning: boolean;
}) {
  return (
    <span className={`process-job-stack-entry is-${entry.kind}${first ? " is-first" : ""}`}>
      {first ? null : <span className="process-job-stack-dot">·</span>}
      {spinning ? <ProcessJobSpinner /> : <ProcessJobGlyph small tone={entry.tone} mark={entry.mark} />}
      <span className="process-job-stack-entry-name">{entry.name}</span>
    </span>
  );
}

/**
 * The closed bar's current rows when there are two or more: each one's status
 * glyph and short name, separated by middle dots, as many whole entries as fit
 * and then "+n" for the rest. The fit is measured, not guessed: a hidden ruler
 * holds every entry, and the list re-measures before paint when its entries
 * change and whenever its own width changes. Its width never depends on how
 * many entries show, so measuring cannot loop.
 *
 * The first in-progress entry carries the bar's one spinner; the others hold
 * still. Assistive tech reads the same list in words, "+n" as "n more".
 */
export function ProcessJobStackCurrent({ entries, trailing }: {
  readonly entries: readonly ProcessJobCurrentEntry[];
  /** Count chips follow the list in the bar's name. */
  readonly trailing: boolean;
}) {
  const listRef = useRef<HTMLSpanElement>(null);
  const rulerRef = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(entries.length);
  const signature = entries.map((entry) => `${entry.key}\u0000${entry.name}\u0000${entry.mark}`).join("\u0001");

  const measure = useCallback(() => {
    const list = listRef.current;
    const ruler = rulerRef.current;
    if (list === null || ruler === null) return;
    const widths = [...ruler.querySelectorAll<HTMLElement>(":scope > .process-job-stack-entry")]
      .map((node) => node.getBoundingClientRect().width);
    const more = ruler.querySelector<HTMLElement>(":scope > .process-job-stack-more")?.getBoundingClientRect().width ?? 0;
    const next = processJobFitCount(widths, () => more, list.getBoundingClientRect().width);
    setShown((current) => current === next ? current : next);
  }, []);

  // Before paint, whenever the entries change: never a frame with the wrong fit.
  useLayoutEffect(measure, [signature, measure]);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list === null || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => measure());
    observer.observe(list);
    return () => observer.disconnect();
  }, [measure]);

  const count = Math.min(Math.max(shown, 1), entries.length);
  const visible = entries.slice(0, count);
  const hidden = entries.slice(count);
  const spinning = visible.findIndex((entry) => entry.mark === "half");
  const words = [
    ...visible.map((entry) => `${entry.name} ${entry.word}`),
    ...(hidden.length > 0 ? [`${String(hidden.length)} more`] : []),
  ].join(", ");

  return (
    <span ref={listRef} className="process-job-stack-current">
      <span className="sr-only">{`${words}${trailing ? "," : ""}`}</span>
      <span className="process-job-stack-entries" aria-hidden="true">
        {visible.map((entry, index) => (
          <Entry key={entry.key} entry={entry} first={index === 0} spinning={index === spinning} />
        ))}
        {hidden.length > 0 ? (
          <span className="process-job-stack-more" title={hidden.map((entry) => `${entry.name} ${entry.word}`).join(", ")}>
            <span className="process-job-stack-dot">·</span>
            {`+${String(hidden.length)}`}
          </span>
        ) : null}
      </span>
      {/* Every entry, laid out but never shown, so the fit reads real widths. */}
      <span ref={rulerRef} className="process-job-stack-ruler" aria-hidden="true">
        {entries.map((entry, index) => <Entry key={entry.key} entry={entry} first={index === 0} spinning={false} />)}
        <span className="process-job-stack-more">
          <span className="process-job-stack-dot">·</span>
          {`+${String(Math.max(entries.length - 1, 1))}`}
        </span>
      </span>
    </span>
  );
}
