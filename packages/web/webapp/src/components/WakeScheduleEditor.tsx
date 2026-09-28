import { Dialog } from "@base-ui/react/dialog";
import { type RefObject, useEffect, useId, useMemo, useRef, useState } from "react";
import type { WebWakeSchedule } from "../../../src/contracts.js";
import { api } from "../api";
import type { ThreadSummary } from "../types";
import { Icon } from "./Icon";
import { WakeSummary } from "./wake/WakeSummary";
import { WakeWhenFields } from "./wake/WakeWhenFields";
import {
  MAX_MESSAGE_BYTES, MESSAGE_COUNTER_FROM, definitionFromDraft, describeDraft, describeWakeError, deviceTimeZone,
  draftFromDefinition, hasIssues, isDraftDirty, newDraft, onceLooksPast, utf8Bytes, validateDraft, weekOrder,
  type WakeDraft,
} from "./wake/wake-schedule-model";

type Busy = "save" | "pause" | "resume" | "delete" | null;
type Failure = { readonly message: string; readonly conflict: boolean; readonly reload?: boolean };

/**
 * The conversation's wake-up schedule, as a modal sheet: a bottom sheet on
 * phones and a centered dialog on wider screens, like the project and tag
 * sheets. Base UI owns modality (portal, focus containment, outside-press and
 * Escape dismissal, scroll lock); this component owns the draft and the
 * server round trips.
 */
export function WakeScheduleEditor({ thread, onClose, returnFocusRef }: {
  readonly thread: ThreadSummary;
  readonly onClose: () => void;
  /** Where focus lands after closing; the menu item that opened this is gone by then. */
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  const deleteRowRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const noteId = useId();
  const messageId = useId();
  const order = useMemo(() => weekOrder(), []);
  // A new schedule's draft is computed once; later renders never move its date.
  const [draft, setDraft] = useState<WakeDraft>(() => newDraft(deviceTimeZone(), new Date()));
  // The loaded, immutable baseline. Its revision is what every mutation expects.
  const [schedule, setSchedule] = useState<WebWakeSchedule | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [changedElsewhere, setChangedElsewhere] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [reloadCount, setReloadCount] = useState(0);
  // A hairline under the fixed header once the body has scrolled beneath it.
  const [scrolled, setScrolled] = useState(false);
  // Request ordering: a read only applies if it is the newest read and no
  // mutation started after it; mutations are serialized by `busy`.
  const readSeq = useRef(0);
  const mutationSeq = useRef(0);
  const latest = useRef({ draft, schedule, loaded });
  latest.current = { draft, schedule, loaded };
  const baseline = schedule?.definition ?? null;
  const dirty = schedule === null || isDraftDirty(draft, baseline);
  const archived = thread.archivedAt != null;
  const liveRevision = thread.wakeSchedule?.revision;

  const adopt = (current: WebWakeSchedule | null) => {
    setSchedule(current);
    if (current !== null) setDraft(draftFromDefinition(current.definition));
    setChangedElsewhere(false);
  };

  const read = async (mode: "initial" | "live" | "explicit") => {
    const seq = ++readSeq.current;
    const mutationAtStart = mutationSeq.current;
    try {
      const { schedule: current } = await api.wakeSchedule(thread.id);
      if (seq !== readSeq.current || mutationAtStart !== mutationSeq.current) return;
      const state = latest.current;
      if (mode === "live" && state.loaded && state.schedule !== null && isDraftDirty(state.draft, state.schedule.definition)) {
        // Keep the operator's edits and their base revision; say so instead.
        if (current?.revision !== state.schedule.revision) setChangedElsewhere(true);
        return;
      }
      if (mode === "live" && state.loaded && state.schedule === null && current !== null) {
        setChangedElsewhere(true);
        return;
      }
      if (mode === "explicit" && current === null) {
        // Deleted elsewhere: keep the draft; the next Save creates it afresh.
        setSchedule(null);
        setChangedElsewhere(false);
      } else adopt(current);
      setLoaded(true);
      setFailure(null);
    } catch (cause) {
      if (seq !== readSeq.current || mutationAtStart !== mutationSeq.current) return;
      const { message } = describeWakeError(cause);
      setFailure({ message: mode === "initial" ? `Couldn't load this schedule. ${message}` : `Couldn't load the latest version. ${message}`,
        conflict: mode === "explicit", reload: mode === "initial" });
    }
  };

  useEffect(() => {
    void read(latest.current.loaded ? "live" : "initial");
    return () => { readSeq.current += 1; };
    // `reloadCount` retries the initial read; the live revision refreshes.
  }, [thread.id, liveRevision, reloadCount]);

  const mutate = async (action: Exclude<Busy, null>) => {
    if (busy !== null) return;
    mutationSeq.current += 1;
    setBusy(action); setFailure(null);
    try {
      if (action === "delete" && schedule !== null) {
        await api.deleteWakeSchedule(thread.id, schedule.revision);
        onClose();
      } else if ((action === "pause" || action === "resume") && schedule !== null) {
        const result = await api.setWakeState(thread.id, schedule.revision, action === "pause" ? "paused" : "active");
        setSchedule(result.schedule);
      } else if (action === "save") {
        await api.saveWakeSchedule(thread.id, definitionFromDraft(draft), schedule?.revision);
        onClose();
      }
    } catch (cause) {
      setFailure(describeWakeError(cause));
      if (action === "delete") { setConfirmingDelete(false); deleteRowRef.current?.focus(); }
    } finally { setBusy(null); }
  };

  const issues = validateDraft(draft);
  const now = new Date();
  // An unchanged saved one-off already explains itself in the summary.
  const pastHint = draft.kind === "once" && dirty && onceLooksPast(draft, now);
  const expired = schedule?.definition.kind === "once" && schedule.state === "paused"
    && onceLooksPast(draftFromDefinition(schedule.definition), now);
  const canSave = loaded && !archived && busy === null && !hasIssues(issues) && dirty;
  const bytes = utf8Bytes(draft.message);
  const edit = (next: Partial<WakeDraft>) => setDraft((current) => ({ ...current, ...next }));

  useEffect(() => { if (confirmingDelete) keepRef.current?.focus(); }, [confirmingDelete]);

  return <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="wake-schedule-backdrop" />
      <Dialog.Popup ref={popupRef} className="sheet wake-schedule-sheet" aria-modal="true" data-scrolled={scrolled || undefined}
        initialFocus={popupRef} finalFocus={returnFocusRef ?? true}>
        <span className="sheet-handle" aria-hidden="true" />
        <header className="sheet-head">
          <Dialog.Close className="sheet-cancel">Cancel</Dialog.Close>
          <Dialog.Title id="wake-schedule-title">Scheduled wake-up</Dialog.Title>
          <button type="button" className="sheet-save" disabled={!canSave} onClick={() => void mutate("save")}>
            {busy === "save" ? "Saving…" : "Save"}
          </button>
        </header>
        <div className="wake-body" aria-busy={!loaded || busy !== null}
          onScroll={(event) => { const next = event.currentTarget.scrollTop > 0; if (next !== scrolled) setScrolled(next); }}>
          {failure !== null && <div className="wake-alert" role="alert">
            <Icon name="alert" size={15} />
            <div className="wake-alert-copy">
              <p>{failure.message}</p>
              {failure.conflict && <p className="wake-alert-detail">Load the latest version to continue. This replaces your unsaved changes.</p>}
            </div>
            {failure.conflict && <button type="button" className="wake-alert-action" onClick={() => void read("explicit")}>Load latest</button>}
            {failure.reload === true && <button type="button" className="wake-alert-action" onClick={() => { setFailure(null); setReloadCount((count) => count + 1); }}>Try again</button>}
          </div>}
          {changedElsewhere && failure === null && <div className="wake-alert is-notice" role="status">
            <Icon name="refresh" size={15} />
            <div className="wake-alert-copy">
              <p>Changed elsewhere while you were editing.</p>
              <p className="wake-alert-detail">Load the latest version before saving. This replaces your unsaved changes.</p>
            </div>
            <button type="button" className="wake-alert-action" onClick={() => void read("explicit")}>Load latest</button>
          </div>}
          <WakeSummary schedule={schedule} sentence={describeDraft(draft, { order })} dirty={schedule !== null && dirty}
            loading={loaded ? false : failure === null ? "loading" : "failed"} archived={archived} expired={expired} busy={busy === "pause" || busy === "resume" ? busy : null}
            noteId={noteId} onToggle={(action) => void mutate(action)} />
          <fieldset className="wake-form" disabled={!loaded || busy !== null}>
            <legend className="sr-only">Schedule</legend>
            <WakeWhenFields draft={draft} issues={issues} pastHint={pastHint} order={order} onChange={edit} />
            <div className="wake-group wake-message">
              <div className="wake-label wake-label-row">
                <label htmlFor={messageId}>Message</label><span className="wake-label-hint">Optional</span>
              </div>
              <textarea id={messageId} className="wake-text" rows={3} value={draft.message} maxLength={MAX_MESSAGE_BYTES}
                placeholder="What should the agent pick up when it wakes?" aria-invalid={issues.message !== undefined || undefined}
                aria-describedby={`${messageId}-help`} onChange={(event) => edit({ message: event.target.value })} />
              <div className="wake-message-foot" id={`${messageId}-help`}>
                <span>Sent to the agent as your message when this conversation wakes.</span>
                {bytes >= MESSAGE_COUNTER_FROM && <span className="wake-counter" data-level={bytes > MAX_MESSAGE_BYTES ? "over" : bytes >= 950 ? "near" : "info"}>
                  {bytes} / {MAX_MESSAGE_BYTES} bytes
                </span>}
              </div>
              <p className="wake-field-error" aria-live="polite">{issues.message ?? ""}</p>
            </div>
          </fieldset>
          {schedule !== null && <div className={`sheet-group wake-delete${confirmingDelete ? " is-confirming" : ""}`}>
            {/* The row stays mounted while confirming, so cancelling can hand focus back to it. */}
            <button ref={deleteRowRef} type="button" className="sheet-row is-danger" disabled={busy !== null || !loaded}
              aria-expanded={confirmingDelete} onClick={() => setConfirmingDelete(true)}>
              <Icon name="trash" size={16} /><span className="sheet-row-label">Delete schedule</span>
            </button>
            {confirmingDelete && <div className="wake-delete-confirm" role="group" aria-label="Confirm deletion">
              <p className="wake-delete-title">Delete this schedule?</p>
              <p className="wake-delete-detail">This removes future wake-ups; an already-started wake-up will continue.</p>
              <div className="wake-delete-actions">
                <button ref={keepRef} type="button" className="wake-delete-keep" disabled={busy !== null}
                  onClick={() => { deleteRowRef.current?.focus(); setConfirmingDelete(false); }}>Keep schedule</button>
                <button type="button" className="wake-delete-go" disabled={busy !== null} onClick={() => void mutate("delete")}>
                  {busy === "delete" ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>}
          </div>}
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
