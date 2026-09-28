import { useId, useState } from "react";
import { Icon } from "../Icon";
import {
  MAX_TIMES, WEEKDAY_NAMES, WEEKDAY_SHORT, deviceTimeZone, nextTimeSlot, normalizeTimeZone,
  type WakeDraft, type WakeIssues, type WakeKind,
} from "./wake-schedule-model";

const timezones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];

/**
 * When the wake-up happens: kind, the once date/time or weekly days/times, and
 * the zone those wall times are read in. Native inputs throughout, so iOS and
 * desktop keep their own pickers; each date/time input sits padding-free inside
 * a styled wrapper because WebKit miscalculates `width: 100%` on padded ones.
 */
export function WakeWhenFields({ draft, issues, pastHint, order, onChange }: {
  readonly draft: WakeDraft;
  readonly issues: WakeIssues;
  readonly pastHint: boolean;
  readonly order: readonly number[];
  readonly onChange: (next: Partial<WakeDraft>) => void;
}) {
  const id = useId();
  const [zoneOpen, setZoneOpen] = useState(false);
  const device = deviceTimeZone();
  const zone = normalizeTimeZone(draft.timezone);
  const showZone = zoneOpen || issues.timezone !== undefined;
  const setTime = (index: number, value: string) => onChange({ times: draft.times.map((entry, at) => at === index ? value : entry) });
  return <div className="wake-when">
    <fieldset className="wake-segmented">
      <legend className="sr-only">Schedule type</legend>
      {(["once", "weekly"] as const satisfies readonly WakeKind[]).map((kind) => (
        <label key={kind} className={`wake-segment${draft.kind === kind ? " is-selected" : ""}`}>
          <input type="radio" name={`${id}-kind`} value={kind} checked={draft.kind === kind}
            onChange={() => onChange({ kind })} />
          <span>{kind === "once" ? "Once" : "Weekly"}</span>
        </label>
      ))}
    </fieldset>

    {draft.kind === "once" ? <div className="wake-group">
      <div className="wake-once-grid">
        <label className="wake-field">
          <span className="wake-label">Date</span>
          <span className={`wake-native-control${issues.when && draft.date === "" ? " is-invalid" : ""}`}>
            <input type="date" value={draft.date} onChange={(event) => onChange({ date: event.target.value })} />
          </span>
        </label>
        <label className="wake-field">
          <span className="wake-label">Time</span>
          <span className={`wake-native-control${issues.when && draft.time === "" ? " is-invalid" : ""}`}>
            <input type="time" value={draft.time} onChange={(event) => onChange({ time: event.target.value })} />
          </span>
        </label>
      </div>
      {issues.when !== undefined
        ? <p className="wake-field-error">{issues.when}</p>
        : pastHint && <p className="wake-field-hint is-warning">This time has already passed{zone === null ? "" : ` in ${zone}`}. Pick a future date or time.</p>}
    </div> : <>
      <fieldset className="wake-group">
        <legend className="wake-label">Days</legend>
        <div className="wake-days">
          {order.map((day) => {
            const checked = draft.days.includes(day);
            return <label key={day} className={`wake-day${checked ? " is-selected" : ""}`}>
              <input type="checkbox" aria-label={WEEKDAY_NAMES[day]} checked={checked}
                onChange={(event) => onChange({ days: event.target.checked ? [...draft.days, day] : draft.days.filter((entry) => entry !== day) })} />
              <span aria-hidden="true">{WEEKDAY_SHORT[day]}</span>
            </label>;
          })}
        </div>
        {issues.days !== undefined && <p className="wake-field-hint">{issues.days}</p>}
      </fieldset>
      <fieldset className="wake-group">
        <legend className="wake-label wake-label-row"><span>Times</span><span className="wake-label-hint">{draft.times.length} of {MAX_TIMES}</span></legend>
        <div className="wake-times">
          {draft.times.map((time, index) => (
            // Index keys keep focus in place while a time is edited; the list is never re-sorted here.
            <div key={index} className={`wake-time wake-native-control${issues.badTimes?.includes(index) ? " is-invalid" : ""}`}>
              <input type="time" aria-label={`Time ${String(index + 1)}`} value={time}
                aria-invalid={issues.badTimes?.includes(index) || undefined}
                onChange={(event) => setTime(index, event.target.value)} />
              {draft.times.length > 1 && <button type="button" className="wake-time-remove" aria-label={`Remove time ${String(index + 1)}`}
                onClick={() => onChange({ times: draft.times.filter((_, at) => at !== index) })}><Icon name="close" size={14} /></button>}
            </div>
          ))}
          {draft.times.length < MAX_TIMES && <button type="button" className="wake-time-add"
            onClick={() => onChange({ times: [...draft.times, nextTimeSlot(draft.times)] })}>
            <Icon name="new" size={14} /><span>Add time</span>
          </button>}
        </div>
        {issues.times !== undefined && <p className="wake-field-error">{issues.times}</p>}
      </fieldset>
    </>}

    <div className="wake-group">
      <button type="button" className="wake-timezone-row" aria-expanded={showZone} aria-controls={`${id}-zone`}
        onClick={() => setZoneOpen(!showZone)}>
        <span className="wake-timezone-label">Timezone</span>
        <span className="wake-timezone-value">{draft.timezone || "Not set"}
          {zone !== null && <span className="wake-timezone-note">{zone === normalizeTimeZone(device) ? " · this device" : " · not this device"}</span>}
        </span>
        <Icon name="chevron-down" size={14} className={showZone ? "is-open" : undefined} />
      </button>
      {showZone && <div className="wake-timezone-panel" id={`${id}-zone`}>
        <label className="wake-field">
          <span className="sr-only">Timezone</span>
          <input className="wake-text" list={`${id}-zones`} value={draft.timezone} placeholder="e.g. Europe/Berlin"
            autoComplete="off" autoCapitalize="none" spellCheck={false} aria-invalid={issues.timezone !== undefined || undefined}
            onChange={(event) => onChange({ timezone: event.target.value })}
            onBlur={() => { const normal = normalizeTimeZone(draft.timezone); if (normal !== null && normal !== draft.timezone) onChange({ timezone: normal }); }} />
        </label>
        <datalist id={`${id}-zones`}>{timezones.map((entry) => <option value={entry} key={entry} />)}</datalist>
        {issues.timezone !== undefined
          ? <p className="wake-field-error">{issues.timezone}</p>
          : <p className="wake-field-hint">The date and times above are read in this timezone.</p>}
        {zone !== normalizeTimeZone(device) && <button type="button" className="wake-text-button" onClick={() => onChange({ timezone: device })}>
          Use this device&apos;s timezone ({device})
        </button>}
      </div>}
    </div>
  </div>;
}
