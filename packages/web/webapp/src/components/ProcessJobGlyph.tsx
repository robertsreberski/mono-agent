import { Icon } from "./Icon";
import type { ProcessJobCallOutcome, ProcessJobKind, ProcessJobMark, ProcessJobTone } from "./process-job-display";
import { processJobCallOutcomesLabel } from "./process-job-display";

/**
 * The inner status mark. Every status family has its own shape, so colour only
 * ever reinforces it: ring = in progress, clock = waiting or ran out of time,
 * square = stopped, ? = question, check = done, × = failed.
 */
export function ProcessJobStatusMark({ mark, animated = false }: {
  readonly mark: ProcessJobMark;
  /** A brief start-up spin (bounded in CSS); never restarted by re-renders. */
  readonly animated?: boolean;
}) {
  if (mark === "ring") return <i className={`process-job-ring${animated ? " is-animated" : ""}`} />;
  if (mark === "stop") return <i className="process-job-stop-mark" />;
  if (mark === "question") return <b className="process-job-question-mark">?</b>;
  return <Icon name={mark} size={mark === "clock" ? 12 : 11} strokeWidth={2.4} />;
}

/**
 * One job's glyph: the OUTER container says what kind of job it is (a
 * rounded square for a command, a circle for an agent) and the INNER mark says
 * its status. Decorative: the row's words carry both meanings.
 */
export function ProcessJobGlyph({ kind, tone, mark, animated = false, small = false }: {
  readonly kind: ProcessJobKind;
  readonly tone: ProcessJobTone;
  readonly mark: ProcessJobMark;
  readonly animated?: boolean;
  readonly small?: boolean;
}) {
  return (
    <span className={`process-job-glyph is-${kind} is-${tone}${small ? " is-small" : ""}`} aria-hidden="true">
      <ProcessJobStatusMark mark={mark} animated={animated} />
    </span>
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
