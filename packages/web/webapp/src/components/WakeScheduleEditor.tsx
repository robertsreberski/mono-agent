import { useEffect, useState } from "react";
import type { WebWakeSchedule, WebWakeScheduleDefinition } from "../../../src/contracts.js";
import { api } from "../api";
import type { ThreadSummary } from "../types";

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function WakeScheduleEditor({ thread, onClose }: { thread: ThreadSummary; onClose: () => void }) {
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
    const controller = new AbortController();
    void api.wakeSchedule(thread.id, controller.signal).then(({ schedule: current }) => {
      if (controller.signal.aborted) return;
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
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };
  return <div className="wake-editor-backdrop" onClick={onClose}>
    <section className="wake-editor" role="dialog" aria-modal="true" aria-label="Schedule wake-up" onClick={(event) => event.stopPropagation()}>
      <header><h2>Scheduled wake-up</h2><button type="button" onClick={onClose} aria-label="Close schedule editor">×</button></header>
      {schedule !== null && <p>State: {schedule.state}. {schedule.nextFireAt !== null
        ? `Next: ${new Date(schedule.nextFireAt).toLocaleString()} (${schedule.definition.timezone})`
        : "No next fire time."}{schedule.lastOutcome !== null ? ` Last outcome: ${schedule.lastOutcome}.` : ""}</p>}
      <label>Schedule type <select value={kind} onChange={(event) => setKind(event.target.value as "once" | "weekly")}>
        <option value="once">One-off</option><option value="weekly">Weekly</option>
      </select></label>
      <label>Timezone (IANA) <input value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder="Europe/Berlin" /></label>
      {kind === "once" ? <label>Local date and time <input type="datetime-local" value={localAt}
        onChange={(event) => setLocalAt(event.target.value)} /></label> : <>
        <fieldset><legend>Days of week</legend>{weekdays.map((day, index) => <label key={day}>
          <input type="checkbox" checked={days.includes(index)} onChange={(event) => setDays(event.target.checked
            ? [...days, index].sort() : days.filter((entry) => entry !== index))} />{day}
        </label>)}</fieldset>
        <fieldset><legend>Times of day (up to 8)</legend>{times.map((time, index) => <div key={index}>
          <input aria-label={`Time ${index + 1}`} type="time" value={time} onChange={(event) => setTimes(times.map((entry, at) => at === index ? event.target.value : entry))} />
          {times.length > 1 && <button type="button" onClick={() => setTimes(times.filter((_, at) => at !== index))}>Remove time</button>}
        </div>)}
          {times.length < 8 && <button type="button" onClick={() => setTimes([...times, "09:00"])}>Add time</button>}
        </fieldset>
      </>}
      <label>Optional message <textarea value={message} onChange={(event) => setMessage(event.target.value)} maxLength={1000} /></label>
      {error && <p className="wake-editor-error" role="alert">{error}</p>}
      <footer><button type="button" disabled={saving} onClick={() => void mutate("save")}>{schedule === null ? "Create schedule" : "Save changes"}</button>
        {schedule !== null && <>
          <button type="button" disabled={saving} onClick={() => void mutate(schedule.state === "active" ? "pause" : "resume")}>{schedule.state === "active" ? "Pause" : "Resume"}</button>
          <button type="button" disabled={saving} onClick={() => void mutate("delete")}>Delete schedule</button>
        </>}</footer>
    </section>
  </div>;
}
