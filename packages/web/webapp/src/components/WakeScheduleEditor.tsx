import { useEffect, useRef, useState } from "react";
import type { WebWakeSchedule, WebWakeScheduleDefinition } from "../../../src/contracts.js";
import { api } from "../api";
import type { ThreadSummary } from "../types";
import { Icon } from "./Icon";
import { shortDateTime } from "./time";

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const timezones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];

export function WakeScheduleEditor({ thread, onClose }: { thread: ThreadSummary; onClose: () => void }) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dirty = useRef(false);
  const [schedule, setSchedule] = useState<WebWakeSchedule | null>(null);
  const [kind, setKind] = useState<"once" | "weekly">("once");
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [localAt, setLocalAt] = useState("");
  const [days, setDays] = useState<number[]>([]);
  const [times, setTimes] = useState<string[]>(["09:00"]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const revision = thread.wakeSchedule?.revision;
  useEffect(() => {
    const previous = document.activeElement;
    dialogRef.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeRef.current();
    };
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("keydown", escape);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void api.wakeSchedule(thread.id, controller.signal).then(({ schedule: current }) => {
      if (controller.signal.aborted || dirty.current) return;
      setSchedule(current);
      if (current === null) return;
      const definition = current.definition;
      setKind(definition.kind);
      setTimezone(definition.timezone);
      setMessage(definition.message ?? "");
      if (definition.kind === "once") setLocalAt(definition.localAt);
      else { setDays([...definition.days]); setTimes([...definition.times]); }
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setError(String(cause)); });
    return () => controller.abort();
  }, [thread.id, revision]);
  const edit = () => { dirty.current = true; };
  const mutate = async (action: "save" | "pause" | "resume" | "delete") => {
    setError(""); setSaving(true);
    try {
      if (action === "delete" && schedule !== null) {
        await api.deleteWakeSchedule(thread.id, schedule.revision);
        setSchedule(null);
        onClose();
      } else if ((action === "pause" || action === "resume") && schedule !== null) {
        const result = await api.setWakeState(thread.id, schedule.revision, action === "pause" ? "paused" : "active");
        setSchedule(result.schedule);
      } else if (action === "save") {
        const definition: WebWakeScheduleDefinition = kind === "once"
          ? { kind, timezone, localAt, ...(message ? { message } : {}) }
          : { kind, timezone, days, times, ...(message ? { message } : {}) };
        const result = await api.saveWakeSchedule(thread.id, definition, schedule?.revision);
        setSchedule(result.schedule);
        dirty.current = false;
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };
  return <div className="sheet-layer" role="presentation" onMouseDown={onClose}>
    <section ref={dialogRef} className="sheet wake-schedule-sheet" role="dialog" aria-modal="true"
      aria-labelledby="wake-schedule-title" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
      <span className="sheet-handle" aria-hidden="true" />
      <header className="sheet-head"><h2 id="wake-schedule-title">Scheduled wake-up</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close schedule editor"><Icon name="close" size={16} /></button>
      </header>
      {schedule !== null && <p className="sheet-footnote">State: {schedule.state}. {schedule.nextFireAt !== null
        ? `Next: ${shortDateTime(schedule.nextFireAt)} (${schedule.definition.timezone})`
        : "No next fire time."}{schedule.lastOutcome !== null ? ` Last outcome: ${schedule.lastOutcome}.` : ""}</p>}
      <label className="sheet-field"><span className="dashboard-section-label">Schedule type</span>
        <select value={kind} onChange={(event) => { edit(); setKind(event.target.value as "once" | "weekly"); }}>
          <option value="once">One-off</option><option value="weekly">Weekly</option>
        </select>
      </label>
      <label className="sheet-field"><span className="dashboard-section-label">Timezone (IANA)</span>
        <input list="wake-timezones" value={timezone} onChange={(event) => { edit(); setTimezone(event.target.value); }} placeholder="Europe/Berlin" />
      </label>
      <datalist id="wake-timezones">{timezones.map((zone) => <option value={zone} key={zone} />)}</datalist>
      {kind === "once" ? <label className="sheet-field"><span className="dashboard-section-label">Local date and time</span>
        <input type="datetime-local" value={localAt} onChange={(event) => { edit(); setLocalAt(event.target.value); }} />
      </label> : <>
        <fieldset className="wake-choice-group"><legend className="dashboard-section-label">Days of week</legend>
          <div className="wake-choice-grid">{weekdays.map((day, index) => <label key={day}>
            <input type="checkbox" checked={days.includes(index)} onChange={(event) => {
              edit(); setDays(event.target.checked ? [...days, index].sort() : days.filter((entry) => entry !== index));
            }} />{day}
          </label>)}</div>
        </fieldset>
        <fieldset className="wake-choice-group"><legend className="dashboard-section-label">Times of day (up to 8)</legend>
          <div className="wake-times">{times.map((time, index) => <div className="wake-time-row" key={index}>
            <label className="sheet-field"><span className="sr-only">Time {index + 1}</span>
              <input aria-label={`Time ${index + 1}`} type="time" value={time} onChange={(event) => {
                edit(); setTimes(times.map((entry, at) => at === index ? event.target.value : entry));
              }} />
            </label>
            {times.length > 1 && <button className="sheet-row" type="button" onClick={() => {
              edit(); setTimes(times.filter((_, at) => at !== index));
            }}>Remove time</button>}
          </div>)}
            {times.length < 8 && <button className="sheet-row" type="button" onClick={() => {
              edit(); setTimes([...times, "09:00"]);
            }}>Add time</button>}
          </div>
        </fieldset>
      </>}
      <label className="sheet-field"><span className="dashboard-section-label">Optional message</span>
        <textarea value={message} onChange={(event) => { edit(); setMessage(event.target.value); }} maxLength={1000} />
      </label>
      {schedule !== null && <div className="sheet-group">
        <button type="button" className="sheet-row" disabled={saving} onClick={() => void mutate(schedule.state === "active" ? "pause" : "resume")}>
          <Icon name={schedule.state === "active" ? "clock" : "restore"} size={16} />
          <span className="sheet-row-label">{schedule.state === "active" ? "Pause" : "Resume"} schedule</span>
        </button>
        <button type="button" className="sheet-row is-danger" disabled={saving} onClick={() => void mutate("delete")}>
          <Icon name="trash" size={16} /><span className="sheet-row-label">Delete schedule</span>
        </button>
      </div>}
      {error && <p className="sheet-error" role="alert">{error}</p>}
      <footer className="wake-schedule-actions">
        <button type="button" className="sheet-cancel" onClick={onClose}>Cancel</button>
        <button type="button" className="primary-button" disabled={saving} onClick={() => void mutate("save")}>
          {schedule === null ? "Create schedule" : "Save changes"}
        </button>
      </footer>
    </section>
  </div>;
}
