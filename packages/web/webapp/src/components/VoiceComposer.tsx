import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import type { VoiceSubmissionSession } from "../console-store";
import { VoiceRecorder, voiceUnavailableReason } from "../voice-recorder";
import { Icon } from "./Icon";

type Phase = "idle" | "permission" | "recording" | "ready" | "transcribing" | "submitting" | "uncertain";
export interface VoiceComposerProps {
  readonly unavailableReason?: string;
  readonly selectionGeneration: number;
  readonly visible?: boolean;
  readonly captureSubmission: () => VoiceSubmissionSession;
  readonly onBusyChange?: (busy: boolean) => void;
}

function useVoiceComposer({ unavailableReason, selectionGeneration, visible = true, captureSubmission, onBusyChange }: VoiceComposerProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string>();
  const recorder = useRef<VoiceRecorder | undefined>(undefined);
  const session = useRef<VoiceSubmissionSession | undefined>(undefined);
  const audio = useRef<Blob | undefined>(undefined);
  const transcript = useRef<string | undefined>(undefined);
  const controller = useRef<AbortController | undefined>(undefined);
  const epoch = useRef(0);
  const sending = useRef(false);
  const dispatched = useRef(false);
  const busy = phase !== "idle";
  const blocked = unavailableReason ?? voiceUnavailableReason();

  const cleanup = () => {
    epoch.current++;
    recorder.current?.dispose();
    recorder.current = undefined;
    controller.current?.abort();
    controller.current = undefined;
    audio.current = undefined;
    transcript.current = undefined;
    session.current = undefined;
    sending.current = false;
    dispatched.current = false;
  };
  const cancel = () => { cleanup(); setPhase("idle"); setError(undefined); setSeconds(0); };
  const ownsOperation = (current: number, signal?: AbortSignal) => {
    if (current !== epoch.current) return false; // Never clean up a newer recording.
    if (session.current?.isCurrent() && !signal?.aborted) return true;
    cancel(); // Same-operation loss must also recover the composer without a rerender.
    return false;
  };
  useEffect(() => () => cleanup(), []);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => {
    if (session.current && (!visible || !session.current.isCurrent())) cancel();
  }, [selectionGeneration, visible]);
  useEffect(() => {
    const leave = () => cancel();
    const hidden = () => { if (document.hidden && !dispatched.current) cancel(); };
    window.addEventListener("pagehide", leave);
    document.addEventListener("visibilitychange", hidden);
    return () => { window.removeEventListener("pagehide", leave); document.removeEventListener("visibilitychange", hidden); };
  }, []);

  const start = () => {
    if (blocked || recorder.current || sending.current) return;
    cleanup();
    const current = epoch.current;
    try { session.current = captureSubmission(); if (!session.current.isCurrent()) throw new Error("stale"); }
    catch { setError("Select a connected, writable conversation before recording."); return; }
    setError(undefined);
    setSeconds(0);
    setPhase("permission");
    const owned = () => ownsOperation(current);
    const capture = new VoiceRecorder({
      recording: () => { if (owned()) setPhase("recording"); },
      elapsed: (elapsed) => { if (owned()) setSeconds(elapsed); },
      ready: (blob) => {
        if (!owned()) return;
        audio.current = blob;
        setPhase("ready");
      },
      error: (message) => { if (epoch.current === current) { cleanup(); setError(message); setPhase("idle"); } },
    });
    recorder.current = capture;
    void capture.start();
  };

  const send = async () => {
    const owner = session.current;
    const blob = audio.current;
    if (sending.current || !owner || (!blob && !transcript.current)) return;
    if (!owner.isCurrent()) { cancel(); return; }
    sending.current = true;
    const current = epoch.current;
    const abort = new AbortController();
    controller.current = abort;
    const owned = () => ownsOperation(current, abort.signal);
    setError(undefined);
    try {
      if (!transcript.current) {
        setPhase("transcribing");
        const threadId = await owner.prepare(abort.signal);
        if (!owned()) return;
        const result = await api.transcribe(threadId, blob!, abort.signal);
        if (!owned()) return;
        transcript.current = result.text;
        audio.current = undefined;
      }
      if (!owned()) return;
      setPhase("submitting");
      dispatched.current = true;
      await owner.submit(transcript.current!);
      if (current === epoch.current) cancel();
    } catch (failure) {
      if (!owned()) return;
      setError(failure instanceof Error ? failure.message : "Voice message failed. Retry Send.");
      setPhase(dispatched.current ? "uncertain" : "ready");
    } finally {
      if (current === epoch.current) { sending.current = false; controller.current = undefined; }
    }
  };

  return { busy, phase, seconds, error, blocked, dispatched: dispatched.current, start,
    onStop: () => recorder.current?.stop(),
    onCancel: () => { if (!dispatched.current) cancel(); }, onSend: () => void send() };
}

// Own capture at the stable Chat boundary, not in the keyed viewport/composer.
// The owner still cleans up on unmount; every genuine selection change is fenced
// by the captured store session. Only that session's createThread handoff survives.
const VoiceScope = createContext<ReturnType<typeof useVoiceComposer> | null>(null);
export function VoiceComposerScope({ children, ...props }: VoiceComposerProps & { readonly children: ReactNode }) {
  const value = useVoiceComposer(props);
  return <VoiceScope.Provider value={value}>{children}</VoiceScope.Provider>;
}
type VoiceSlot = "tool" | "body" | "cancel" | "action";
export function ScopedVoiceComposer({ slot }: { readonly slot: VoiceSlot }) {
  const voice = useContext(VoiceScope);
  return voice ? <VoiceContent voice={voice} slot={slot} /> : null;
}
export function useVoiceBusy() { return useContext(VoiceScope)?.busy ?? false; }

/** Standalone lifecycle fixture; the console uses the stable scoped owner. */
export function VoiceComposer(props: VoiceComposerProps) {
  const voice = useVoiceComposer(props);
  return <div className="composer-root"><div className="composer-dropzone">
    <VoiceContent voice={voice} slot="body" />
    <div className="composer-toolbar">
      <div className="composer-tools"><VoiceContent voice={voice} slot="tool" /><VoiceContent voice={voice} slot="cancel" /></div>
      <div className="composer-actions"><VoiceContent voice={voice} slot="action" /></div>
    </div>
  </div></div>;
}

function VoiceContent({ voice, slot }: { readonly voice: ReturnType<typeof useVoiceComposer>; readonly slot: VoiceSlot }) {
  if (slot === "tool") return !voice.busy ? <VoiceRecordControl blocked={voice.blocked} onStart={voice.start} /> : null;
  if (slot === "body") return voice.busy ? <VoiceStatus {...voice} /> : voice.error ? <p className="voice-error" role="alert">{voice.error}</p> : null;
  return voice.busy ? <VoiceAction {...voice} slot={slot} /> : null;
}

function VoiceRecordControl({ blocked, onStart }: { readonly blocked?: string; readonly onStart: () => void }) {
  const id = useId();
  const [explain, setExplain] = useState(false);
  return <>
    <button type="button" className="icon-button composer-tool voice-record" aria-label="Record voice message"
      title={blocked ?? "Record a voice message"} aria-disabled={Boolean(blocked)} aria-describedby={blocked ? id : undefined}
      onFocus={() => setExplain(true)} onBlur={() => setExplain(false)} onKeyDown={(event) => { if (event.key === "Escape") setExplain(false); }}
      onClick={() => { if (blocked) setExplain(true); else onStart(); }}>
      <Icon name="mic" size={17} />
    </button>
    {blocked && <span id={id} className={explain ? "voice-availability" : "sr-only"}>{blocked}</span>}
  </>;
}

type ActiveVoiceProps = {
  readonly phase: Phase;
  readonly seconds?: number;
  readonly error?: string;
  readonly dispatched?: boolean;
  readonly onStop?: () => void;
  readonly onCancel?: () => void;
  readonly onSend?: () => void;
};
function focusVoiceControl(element: HTMLElement | null) {
  const root = element?.closest(".composer-root");
  if (document.activeElement === document.body || root?.contains(document.activeElement)) {
    element?.focus({ preventScroll: true });
  }
}

function VoiceStatus({ phase, seconds = 0, error }: ActiveVoiceProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (phase === "submitting") focusVoiceControl(ref.current); }, [phase]);
  const label = phase === "permission" ? "Allow microphone access…"
    : phase === "recording" ? "Recording"
    : phase === "ready" ? "Voice message ready"
    : phase === "transcribing" ? "Transcribing…"
    : phase === "submitting" ? "Submitting request…" : "Submission not confirmed";
  return <div ref={ref} tabIndex={-1} className="voice-body" data-phase={phase} aria-label="Voice message">
    <div className="voice-status-line">
      {phase === "recording" ? <span className="voice-recording-dot" aria-hidden="true" /> : <Icon name={phase === "ready" ? "check" : "mic"} size={16} />}
      <span role="status">{label}</span>
      {(phase === "recording" || phase === "ready") && <span className="voice-time" role="timer" aria-live="off" aria-label="Recording duration">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}{phase === "recording" && <span className="voice-limit"> / 2:00</span>}</span>}
    </div>
    {phase === "ready" && !error && <p className="voice-detail">Send to transcribe and submit. Audio isn’t saved.</p>}
    {phase === "uncertain" && <p className="voice-detail">Retry checks the same request. It won’t send twice.</p>}
    {phase === "submitting" && <p className="voice-detail">Dispatched — waiting for confirmation.</p>}
    {error && <p className="voice-error" role="alert">{error}</p>}
  </div>;
}
function VoiceAction({ slot, phase, dispatched, onStop, onCancel, onSend }: ActiveVoiceProps & { readonly slot: "cancel" | "action" }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Each explicit step keeps keyboard focus in the operation, not on a removed
    // microphone/Stop button. Timer ticks never move focus or announce a status.
    const primary = phase === "recording" || phase === "ready" || phase === "uncertain";
    if ((slot === "action" && primary) || (slot === "cancel" && !primary)) focusVoiceControl(ref.current);
  }, [phase, slot]);
  if (slot === "cancel") return !dispatched ? <button ref={ref} type="button" className="voice-cancel" aria-label="Cancel voice message" onClick={onCancel}><Icon name="close" size={16} />Cancel</button> : null;
  if (phase === "recording") return <button ref={ref} type="button" className="composer-stop voice-primary" aria-label="Stop recording" onClick={onStop}><Icon name="stop" size={14} />Stop</button>;
  if (phase === "ready" || phase === "uncertain") return <button ref={ref} type="button" className="composer-send voice-primary" aria-label={phase === "uncertain" ? "Retry submission" : "Send voice message"} onClick={onSend}><Icon name={phase === "uncertain" ? "refresh" : "send"} size={16} />{phase === "uncertain" ? "Retry" : "Send"}</button>;
  if (phase === "transcribing" || phase === "submitting") return <button type="button" className="composer-send voice-progress" aria-label="Processing voice message" disabled><Icon name="clock" size={16} /></button>;
  return null;
}

/** Synthetic presentation fixture, using the same composer slots as Chat. */
export function VoiceMessagePanel(props: ActiveVoiceProps) {
  return <div className="composer-root"><div className="composer-dropzone">
    <VoiceStatus {...props} />
    <div className="composer-toolbar">
      <div className="composer-tools"><VoiceAction {...props} slot="cancel" /></div>
      <div className="composer-actions"><VoiceAction {...props} slot="action" /></div>
    </div>
  </div></div>;
}
