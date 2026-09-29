import type { ReactNode } from "react";

import type { ProcessJobCallOutcome, ProcessJobMark, ProcessJobTone } from "./process-job-display";
import { processJobCallOutcomesLabel } from "./process-job-display";

/*
 * Every status glyph is drawn on the same 20-unit grid: an 18-unit circle with
 * a 1.5-unit ring, centred, so the family shares one diameter, one stroke and
 * one optical centre at every size. Geometry lives here; paint (tone colour,
 * stroke weight per size, the cut-out colour) lives in the stylesheet.
 */
const RING = <circle className="process-job-glyph-ring" cx="10" cy="10" r="8.25" />;
const DISC = <circle className="process-job-glyph-solid" cx="10" cy="10" r="9" />;
/** The right half of an inner disc: in progress, never a measured fraction. */
const HALF = "M10 5.4a4.6 4.6 0 0 1 0 9.2z";
const QUESTION = "M8.15 7.9a1.9 1.9 0 1 1 2.75 1.7c-.55.28-.9.72-.9 1.3v.35";
const CHECK = "M6.6 10.3l2.3 2.3 4.5-4.8";
const CROSS = "M7.6 7.6l4.8 4.8M12.4 7.6l-4.8 4.8";
const CLOCK = "M10 5.9V10l2.8 1.8";

const SHAPES: Readonly<Record<ProcessJobMark, ReactNode>> = {
  empty: RING,
  half: <>{RING}<path className="process-job-glyph-solid" d={HALF} /></>,
  stop: <>{RING}<rect className="process-job-glyph-solid" x="7.1" y="7.1" width="5.8" height="5.8" rx="1.3" /></>,
  question: <>{RING}<path className="process-job-glyph-line" d={QUESTION} /><circle className="process-job-glyph-solid" cx="10" cy="13.55" r="1" /></>,
  check: <>{DISC}<path className="process-job-glyph-cut" d={CHECK} /></>,
  cross: <>{DISC}<path className="process-job-glyph-cut" d={CROSS} /></>,
  clock: <>{DISC}<path className="process-job-glyph-cut" d={CLOCK} /></>,
  stopped: <>{DISC}<rect className="process-job-glyph-cut-solid" x="7.25" y="7.25" width="5.5" height="5.5" rx="1.2" /></>,
};

/**
 * One job's status glyph. Outlined rings are current work (empty = queued,
 * half = in progress, square = stopping, ? = question); solid discs are settled
 * outcomes (check = done, × = failed, clock hands = ran out of time, square =
 * cancelled). It never moves. Decorative: the row's words carry the meaning.
 */
export function ProcessJobGlyph({ tone, mark, small = false }: {
  readonly tone: ProcessJobTone;
  readonly mark: ProcessJobMark;
  /** The closed bar's size. */
  readonly small?: boolean;
}) {
  return (
    <svg
      className={`process-job-glyph is-${tone} is-${mark}${small ? " is-small" : ""}`}
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
    >
      {SHAPES[mark]}
    </svg>
  );
}

/**
 * The last few recorded tool calls of a detached agent, oldest first, as
 * distinct shapes: dot = complete, × = failed, hollow ring = running.
 * Categorical evidence of rhythm and failures, never a progress claim.
 */
export function ProcessJobCallOutcomes({ outcomes }: { readonly outcomes: readonly ProcessJobCallOutcome[] }) {
  if (outcomes.length === 0) return null;
  const label = processJobCallOutcomesLabel(outcomes);
  return (
    <span className="process-job-calls" role="img" aria-label={label} title={label}>
      {outcomes.map((outcome, index) => <i key={index} className={`is-${outcome}`} />)}
    </span>
  );
}
