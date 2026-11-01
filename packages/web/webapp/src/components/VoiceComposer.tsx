import { ComposerPrimitive, useAssistantRuntime, useAuiState } from "@assistant-ui/react";
import { Menu } from "@base-ui/react/menu";
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createAudioLevelStore } from "../audio-level-store";
import { useConsoleStore } from "../console-store";
import { useRecordedAudio } from "../recorded-audio-context";
import { recordingFile, VoiceRecorder, voiceUnavailableReason } from "../voice-recorder";
import { Icon } from "./Icon";

type CapturePhase = "idle" | "permission" | "recording" | "attaching";
interface CaptureState {
  readonly phase: CapturePhase;
  readonly seconds: number;
  resumeVisualization(): void;
  readonly error?: string;
  readonly blocked?: string;
  readonly retryAttachment?: () => void;
  start(): void;
  stop(): void;
  cancel(): void;
}
const emptyLevels = createAudioLevelStore();
const LevelContext = createContext(emptyLevels);
const CaptureContext = createContext<CaptureState | null>(null);

/** Capture stays above keyed Composer. Submission belongs only to normal Send. */
export function VoiceComposerScope({ children, unavailableReason }: { readonly children: ReactNode; readonly unavailableReason?: string }) {
  const store = useConsoleStore();
  const runtime = useAssistantRuntime();
  const attachments = useAuiState((state) => state.composer.attachments);
  const recorded = useRecordedAudio();
  const [phase, setPhase] = useState<CapturePhase>("idle");
  const [seconds, setSeconds] = useState(0);
  const [levelStore] = useState(createAudioLevelStore);
  const [error, setError] = useState<string>();
  const [finished, setFinished] = useState<{ file: File; generation: number; sourceId: string | null; threadId: string | null }>();
  const capture = useRef<VoiceRecorder | undefined>(undefined);
  const epoch = useRef(0);
  const attaching = useRef<{ controller: AbortController; remove: () => void } | undefined>(undefined);
  const target = useRef<(() => boolean) | undefined>(undefined);
  const current = useRef(store);
  current.current = store;
  const cleanup = (cancelAttachment = true) => {
    epoch.current++;
    capture.current?.dispose(); capture.current = undefined; target.current = undefined;
    const pending = attaching.current; attaching.current = undefined;
    if (cancelAttachment && pending) { pending.controller.abort(); pending.remove(); }
  };
  const attach = (file: File) => {
    const controller = new AbortController();
    recorded!.adapter.registerRecording(file, controller.signal);
    const composer = runtime.thread.composer;
    attaching.current = { controller, remove: () => {
      composer.getState().attachments.forEach((item, index) => {
        if (item.file === file) void composer.getAttachmentByIndex(index).remove().catch(() => undefined);
      });
    } };
    return composer.addAttachment(file);
  };
  const cancel = () => { cleanup(); setPhase("idle"); setError(undefined); setSeconds(0); setFinished(undefined); };
  useEffect(() => () => cleanup(), []);
  useEffect(() => {
    if (target.current && !target.current() || finished && !ownsFinished()) cancel();
  }, [store.selectionGeneration, store.conversationVisible]);
  const ownsFinished = () => finished && current.current.selectionGeneration === finished.generation && current.current.selectedAgentId === finished.sourceId
    && current.current.selectedThreadId === finished.threadId && current.current.conversationVisible;
  const retryAttachment = async () => {
    if (!finished || !ownsFinished()) return;
    cleanup();
    // Same-conversation identity is not enough after hide/cancel/new capture.
    // This immutable epoch also owns all retry completion/error state effects.
    const token = epoch.current;
    const ownsRetry = () => token === epoch.current && Boolean(ownsFinished());
    target.current = ownsRetry;
    setPhase("attaching"); setError(undefined);
    try {
      await attach(finished.file);
      if (!ownsRetry()) return;
      cleanup(false); setFinished(undefined); setPhase("idle");
    } catch (failure) {
      if (!ownsRetry()) return;
      cleanup(false);
      if (failure instanceof DOMException && failure.name === "AbortError") { setFinished(undefined); setPhase("idle"); return; }
      const hasChip = runtime.thread.composer.getState().attachments.some((item) => item.file === finished.file);
      if (hasChip) setFinished(undefined);
      setError(hasChip ? undefined : failure instanceof Error ? failure.message : "The recording could not be attached."); setPhase("idle");
    }
  };
  useEffect(() => {
    const leave = () => cancel();
    const hidden = () => { if (document.hidden) cancel(); };
    window.addEventListener("pagehide", leave); document.addEventListener("visibilitychange", hidden);
    return () => { window.removeEventListener("pagehide", leave); document.removeEventListener("visibilitychange", hidden); };
  }, []);
  const blocked = (finished ? "Retry or remove the finished recording first." : undefined) ?? unavailableReason ?? voiceUnavailableReason() ?? (!recorded?.adapter.recordingBudget(attachments) ? "Remove an attachment to make room for a recording." : undefined);
  const start = () => {
    if (blocked || phase !== "idle" || !recorded) return;
    cleanup();
    const token = epoch.current;
    const generation = store.selectionGeneration;
    const sourceId = store.selectedAgentId;
    const threadId = store.selectedThreadId;
    const owns = () => token === epoch.current && current.current.selectionGeneration === generation
      && current.current.selectedAgentId === sourceId && current.current.selectedThreadId === threadId && current.current.conversationVisible;
    target.current = owns;
    setError(undefined); setSeconds(0); levelStore.publish([]); setPhase("permission");
    const recorder = new VoiceRecorder({
      recording: () => { if (owns()) setPhase("recording"); },
      levels: (values) => { if (owns()) levelStore.publish(values); },
      elapsed: (value) => { if (owns()) setSeconds(value); },
      error: (message) => { if (owns()) { cleanup(); setError(message); setPhase("idle"); } },
      ready: (blob) => {
        if (!owns()) return;
        setPhase("attaching");
        void (async () => {
          let file: File | undefined;
          try {
            file = recordingFile(blob);
            await attach(file);
            if (owns()) { cleanup(false); setPhase("idle"); }
          } catch (failure) {
            if (owns()) {
              if (failure instanceof DOMException && failure.name === "AbortError") { cleanup(false); setPhase("idle"); return; }
              const hasChip = file && runtime.thread.composer.getState().attachments.some((item) => item.file === file);
              if (file && !hasChip) setFinished({ file, generation, sourceId, threadId });
              cleanup(false); setPhase("idle"); setError(hasChip ? undefined : failure instanceof Error ? failure.message : "The recording could not be attached. Record again.");
            }
          }
        })();
      },
    }, recorded.adapter.recordingBudget(attachments));
    capture.current = recorder;
    void recorder.start();
  };
  return <LevelContext.Provider value={levelStore}><CaptureContext.Provider value={{ phase, seconds, resumeVisualization: () => capture.current?.resumeVisualization(), error, blocked, retryAttachment: finished ? () => void retryAttachment() : undefined, start, stop: () => capture.current?.stop(), cancel }}>{children}</CaptureContext.Provider></LevelContext.Provider>;
}
export const useVoiceBusy = () => { const phase = useContext(CaptureContext)?.phase; return phase !== undefined && phase !== "idle"; };

export const useUnattachedRecording = () => Boolean(useContext(CaptureContext)?.retryAttachment);

export function AttachmentMenu() {
  const capture = useContext(CaptureContext);
  return <Menu.Root><Menu.Trigger className="icon-button composer-tool" aria-label="Add attachment" title="Add attachment"><Icon name="attach" size={17} /></Menu.Trigger>
    <Menu.Portal><Menu.Positioner className="conversation-menu-positioner" side="top" align="start" sideOffset={8}><Menu.Popup className="menu-popup attachment-menu">
      <Menu.Item nativeButton render={<ComposerPrimitive.AddAttachment multiple />} className="menu-item"><Icon name="file" size={16} />Upload files</Menu.Item>
      <Menu.Item className="menu-item" aria-disabled={Boolean(capture?.blocked)} onClick={() => { if (!capture?.blocked) capture?.start(); }}><Icon name="mic" size={16} />Record audio</Menu.Item>
      {capture?.blocked && <p className="attachment-menu-reason">{capture.blocked}</p>}
    </Menu.Popup></Menu.Positioner></Menu.Portal>
  </Menu.Root>;
}

export function RecordingCapture() {
  const capture = useContext(CaptureContext);
  return capture && capture.phase !== "idle" ? <CaptureStatus phase={capture.phase} seconds={capture.seconds} onResume={capture.resumeVisualization} onStop={capture.stop} onCancel={capture.cancel} /> : null;
}

export function RecordingDraft() {
  const capture = useContext(CaptureContext);
  const recorded = useRecordedAudio();
  if (!capture) return null;
  return <>
    {capture.retryAttachment && capture.phase === "idle" && <div className="recording-draft"><span>Recording not attached</span><button type="button" className="attachment-retry" onClick={capture.retryAttachment}>Retry attachment</button><button type="button" className="icon-button" aria-label="Remove recording" onClick={capture.cancel}><Icon name="close" size={14} /></button></div>}
    {(capture.error || recorded?.error) && <p role="alert" className="voice-error">{capture.error ?? recorded?.error}</p>}
    {recorded?.busy && <div className="recording-draft voice-preparing" role="status"><span className="voice-spinner" aria-hidden="true" />Preparing message…</div>}
    {recorded?.uncertain && <div className="recording-draft"><Icon name="refresh" size={16} /><button type="button" className="attachment-retry" onClick={recorded.retry}>Check / retry send</button></div>}
  </>;
}

/** Presentation seam used by the actual recording draft and synthetic stories. */
export function CaptureStatus({ phase, seconds, levels, onStop, onCancel, onResume }: { readonly phase: Exclude<CapturePhase, "idle">; readonly seconds: number; readonly levels?: readonly number[]; readonly onStop?: () => void; readonly onCancel?: () => void; readonly onResume?: () => void }) {
  const row = useRef<HTMLDivElement>(null);
  const stop = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (phase === "recording") stop.current?.focus({ preventScroll: true });
    // Keep capture actions visible when earlier attachments fill the chip scroller.
    const viewport = row.current?.closest<HTMLElement>(".composer-attachments");
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [phase]);
  return <div ref={row} className={`capture-pill voice-note-player is-${phase}`} onPointerDown={onResume}>
    {phase === "recording" ? <button ref={stop} type="button" className="icon-button voice-stop" aria-label="Stop recording" onClick={onStop}><span className="voice-action-face"><Icon name="stop" size={14} /></span></button> : <span className="voice-face-slot" aria-hidden="true">{phase === "attaching" && <span className="voice-action-face"><span className="voice-spinner" /></span>}</span>}
    <div className="voice-note-body">
      <span className="sr-only" role="status">{phase === "permission" ? "Allow microphone access…" : phase === "attaching" ? "Attaching recording…" : "Recording"}</span>
      {phase === "permission" ? <span className="capture-label" aria-hidden="true">Allow microphone…</span> : <CaptureMeter phase={phase} levels={levels} />}
    </div>
    {phase !== "permission" && <span className="voice-note-time capture-time">{phase === "recording" && <span className="voice-recording-dot" aria-hidden="true" />}<span className="voice-time" role="timer" aria-live="off">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span></span>}
    <div className="voice-note-actions">{phase !== "attaching" ? <button type="button" className="icon-button voice-discard" aria-label="Cancel recording" onClick={onCancel}><Icon name="close" size={14} /></button> : <span className="voice-face-slot" aria-hidden="true" />}</div>
  </div>;
}

function CaptureMeter({ phase, levels }: { readonly phase: CapturePhase; readonly levels?: readonly number[] | undefined }) {
  const store = useContext(LevelContext);
  const sampled = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const history = levels ?? sampled;
  // Two bars per sample preserve the 24-sample history in the note’s 48-bar grid.
  return <span className="capture-meter" aria-hidden="true">{Array.from({ length: 48 }, (_, i) => <i key={i} style={{ height: `${3 + (phase === "recording" ? history[Math.floor(i / 2)] ?? 0 : 0) * 17}px` }} />)}</span>;
}
