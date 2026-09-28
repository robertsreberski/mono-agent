import type { WebWakeSchedule } from "../../../../src/contracts.js";
import { Icon } from "../Icon";
import { OUTCOME_COPY, STATE_LABEL, deviceTimeZone, describeNextFire } from "./wake-schedule-model";

/**
 * What will happen, and what Save changes. The sentence always describes the
 * draft; saved facts (state, next wake-up, last outcome) appear only while the
 * draft still matches what is saved, so they never sit above different edits.
 */
export function WakeSummary({ schedule, sentence, dirty, loading, archived, expired, busy, noteId, onToggle }: {
  readonly schedule: WebWakeSchedule | null;
  readonly sentence: string | null;
  readonly dirty: boolean;
  /** Before the first read resolves: still waiting, or the read failed. */
  readonly loading: false | "loading" | "failed";
  readonly archived: boolean;
  /** A paused one-off whose wall time has clearly passed: it cannot resume unchanged. */
  readonly expired: boolean;
  /** Any mutation in flight (save, pause, resume, delete) disables the toggle. */
  readonly busy: "save" | "pause" | "resume" | "delete" | null;
  readonly noteId: string;
  readonly onToggle: (next: "pause" | "resume") => void;
}) {
  if (loading !== false) return <section className="wake-summary" data-state="loading" aria-label="Schedule summary">
    <p className="wake-summary-state"><span className="wake-state">{loading === "failed" ? "Schedule unavailable" : "Loading schedule…"}</span></p>
  </section>;
  const saved = schedule !== null && !dirty;
  const state = schedule === null ? "new" : dirty ? "dirty" : schedule.state;
  const label = schedule === null ? "Not scheduled yet" : dirty ? "Unsaved changes" : STATE_LABEL[schedule.state];
  const toggle = schedule === null || schedule.state === "completed" || (schedule.state === "paused" && expired)
    ? null : schedule.state === "active" ? "pause" as const : "resume" as const;
  const toggleBlocked = dirty || (toggle === "resume" && archived);
  const next = saved && schedule.state === "active" && schedule.nextFireAt !== null
    ? describeNextFire(schedule.nextFireAt, schedule.definition.timezone, deviceTimeZone()) : null;
  const note = archived && schedule?.state !== "active"
    ? "This conversation is archived. Restore it to save or resume this schedule."
    : archived ? "This conversation is archived. Restore it before saving changes."
      : schedule === null ? null
        : dirty ? (schedule.state === "active" ? "Save to apply these changes." : "Save turns this schedule on.")
          : schedule.state === "active" && schedule.nextFireAt === null ? "Waiting to run when the agent and conversation are available."
            : schedule.state === "paused" && expired ? "Paused, and its time has passed. Pick a future date to schedule it again."
              : schedule.state === "paused" ? "No wake-ups until you resume it."
                : schedule.state === "completed" ? "No further wake-ups. Pick a new date and time to schedule it again." : null;
  const outcome = saved && schedule.lastOutcome !== null ? OUTCOME_COPY[schedule.lastOutcome] : null;
  return <section className="wake-summary" data-state={state} aria-label="Schedule summary">
    <div className="wake-summary-top">
      <span className="wake-state" data-state={state}>{state === "active" && <i aria-hidden="true" />}{label}</span>
      {toggle !== null && <button type="button" className="wake-inline-action" disabled={toggleBlocked || busy !== null}
        aria-describedby={toggleBlocked ? noteId : undefined} onClick={() => onToggle(toggle)}>
        {busy === "pause" ? "Pausing…" : busy === "resume" ? "Resuming…" : toggle === "pause" ? "Pause" : "Resume"}
        <span className="sr-only"> schedule</span>
      </button>}
    </div>
    <p className={`wake-summary-sentence${sentence === null ? " is-empty" : ""}`}>{sentence ?? "Finish the schedule below."}</p>
    {next !== null && <p className="wake-summary-meta">
      Next: {next.scheduled} <span className="wake-summary-zone">({schedule!.definition.timezone})</span>
      {next.local !== null && <span className="wake-summary-local"> · {next.local} your time</span>}
    </p>}
    {note !== null && <p className="wake-summary-note" id={noteId}>{note}</p>}
    {outcome !== null && <p className="wake-outcome" data-tone={outcome.tone}>
      <Icon name={outcome.tone === "success" ? "check" : outcome.tone === "muted" ? "clock" : "alert"} size={13} />{outcome.text}
    </p>}
  </section>;
}
