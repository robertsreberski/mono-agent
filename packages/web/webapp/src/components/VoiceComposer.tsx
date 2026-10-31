import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import type { VoiceSubmissionSession } from "../console-store";
import { VoiceRecorder, voiceUnavailableReason } from "../voice-recorder";

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

  if (!busy) return { busy, view: <div className="voice-composer voice-idle">
    <button type="button" className="icon-button composer-tool" aria-label="Record voice message" title={blocked ?? "Record a voice message"} disabled={Boolean(blocked)} onClick={start}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>
    </button>
    <span className="voice-note">{blocked ?? "Voice Send transcribes and sends your request."}</span>
    {error && <p role="alert">{error}</p>}
  </div> };
  return { busy, view: <VoiceMessagePanel phase={phase} seconds={seconds} error={error} dispatched={dispatched.current}
    onStop={() => recorder.current?.stop()} onCancel={() => { if (!dispatched.current) cancel(); }} onSend={() => void send()} /> };
}

// Own capture at the stable Chat boundary, not in the keyed viewport/composer.
// The owner still cleans up on unmount; every genuine selection change is fenced
// by the captured store session. Only that session's createThread handoff survives.
const VoiceScope = createContext<ReturnType<typeof useVoiceComposer> | null>(null);
export function VoiceComposerScope({ children, ...props }: VoiceComposerProps & { readonly children: ReactNode }) {
  const value = useVoiceComposer(props);
  return <VoiceScope.Provider value={value}>{children}</VoiceScope.Provider>;
}
export function ScopedVoiceComposer() { return useContext(VoiceScope)?.view ?? null; }
export function useVoiceBusy() { return useContext(VoiceScope)?.busy ?? false; }
/** Standalone lifecycle fixture; the console uses the stable scoped owner. */
export function VoiceComposer(props: VoiceComposerProps) { return useVoiceComposer(props).view; }

/** Presentational seam for deterministic browser/story fixtures; no capture side effects. */
export function VoiceMessagePanel({ phase, seconds = 0, error, dispatched = false, onStop, onCancel, onSend }: {
  readonly phase: Exclude<Phase, "idle">;
  readonly seconds?: number;
  readonly error?: string;
  readonly dispatched?: boolean;
  readonly onStop?: () => void;
  readonly onCancel?: () => void;
  readonly onSend?: () => void;
}) {
  return <section className="voice-composer voice-panel" aria-label="Voice message">
    <p role="status" aria-live="polite">{phase === "permission" ? "Allow microphone access to record…"
      : phase === "recording" ? `Recording · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} / 2:00`
      : phase === "ready" ? "Recording ready to send"
      : phase === "transcribing" ? "Transcribing…"
      : phase === "submitting" ? "Submitting request…"
      : "Submission not confirmed. Retry checks the same request; it does not transcribe again."}</p>
    <p className="voice-note">Send transcribes and submits an ordinary request. Audio is not saved. {dispatched ? "After dispatch, use Stop response; cancellation cannot withdraw the request." : "Cancel discards audio before submission."}</p>
    {error && <p role="alert">{error}</p>}
    <div className="voice-actions">
      {phase === "recording" && <button type="button" onClick={onStop}>Stop recording</button>}
      {!dispatched && <button type="button" onClick={onCancel}>Cancel voice message</button>}
      {(phase === "ready" || phase === "uncertain") && <button type="button" className="composer-send" onClick={onSend}>{phase === "uncertain" ? "Retry submission" : "Send voice message"}</button>}
    </div>
  </section>;
}
