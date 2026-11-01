import { useEffect, useRef, useState, type ReactNode } from "react";
import { cachedWaveform, loadAudio, prepareWaveform, type Waveform } from "../audio-waveform";
import { VOICE_MAX_BYTES } from "../voice-recorder";
import { Icon } from "./Icon";

export const audioTime = (value: number) => `${Math.floor(Math.max(0, value) / 60)}:${String(Math.floor(Math.max(0, value)) % 60).padStart(2, "0")}`;
export interface VoiceNoteProps {
  readonly id: string;
  readonly name: string;
  readonly contentType: string;
  readonly file?: File | undefined;
  readonly recorded?: boolean;
  readonly uploading?: number | undefined;
  readonly failed?: boolean;
  readonly onRetry?: (() => void) | undefined;
  readonly actions?: ReactNode;
  readonly caption?: string | undefined;
}
/** A normal attachment with a custom, keyboard-accessible media surface. */
export function VoiceNote({ id, name, contentType, file, recorded, uploading, failed, onRetry, actions, caption }: VoiceNoteProps) {
  const root = useRef<HTMLDivElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const [waveform, setWaveform] = useState<Waveform | undefined>(() => cachedWaveform(id));
  const [src, setSrc] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  const owner = useRef<{ controller: AbortController; url?: string } | undefined>(undefined);
  useEffect(() => { const media = audio.current; return () => {
    owner.current?.controller.abort();
    if (media?.getAttribute("src")) { media.pause(); media.removeAttribute("src"); media.load(); }
    if (owner.current?.url) URL.revokeObjectURL(owner.current.url);
    owner.current = undefined;
  }; }, [id, file]);
  useEffect(() => {
    let controller: AbortController | undefined;
    let dwell: ReturnType<typeof setTimeout> | undefined;
    const prepare = () => {
      controller?.abort();
      controller = new AbortController(); const signal = controller.signal;
      void prepareWaveform(id, file, contentType, signal).then(value => {
        if (!signal.aborted && value) setWaveform(value);
      }).catch(() => undefined); // A preview is optional, never an upload/playback error.
    };
    const cancel = () => { clearTimeout(dwell); controller?.abort(); };
    if (file) { prepare(); return cancel; }
    const cached = cachedWaveform(id);
    if (cached) { setWaveform(cached); return; }
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    if (connection?.saveData || typeof IntersectionObserver === "undefined" || !root.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        clearTimeout(dwell); dwell = setTimeout(prepare, 250);
      } else cancel();
    });
    observer.observe(root.current);
    return () => { cancel(); observer.disconnect(); };
  }, [id, file, contentType]);
  const duration = waveform?.duration ?? mediaDuration;
  const label = recorded || caption ? "Voice note" : name;
  const accessibleLabel = label === "Voice note" ? "voice note" : label;
  const play = () => {
    const media = audio.current;
    if (!media) return;
    if (playing) { media.pause(); return; }
    const attemptPlay = (signal: AbortSignal) => {
      setReady(false); setError(undefined);
      // Called synchronously in the click handler for local files / loaded URLs.
      void media.play().catch(() => {
        if (signal.aborted) return;
        if (media.error) setError("Audio preview unavailable. Use Download.");
        else setReady(true);
      });
    };
    if (src && owner.current) { attemptPlay(owner.current.controller.signal); return; }
    if (loading) return;
    const task = { controller: new AbortController(), url: undefined as string | undefined };
    owner.current = task; setError(undefined);
    const attach = (blob: Blob) => {
      task.url = URL.createObjectURL(blob); media.src = task.url; setSrc(task.url);
      attemptPlay(task.controller.signal);
    };
    if (file) {
      if (file.size > VOICE_MAX_BYTES) { setError("Download this file to play it."); return; }
      attach(file); // No await: preserve the iOS user gesture.
      if (!waveform) void prepareWaveform(id, file, contentType, task.controller.signal).then(value => {
        if (!task.controller.signal.aborted && value) setWaveform(value);
      }).catch(() => undefined);
      return;
    }
    setLoading(true);
    void loadAudio(id, undefined, contentType, task.controller.signal).then(result => {
      if (task.controller.signal.aborted) return;
      if (result.waveform) setWaveform(result.waveform);
      attach(result.blob);
    }).catch(failure => {
      if (!task.controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Audio preview unavailable. Try again or download.");
    }).finally(() => { if (!task.controller.signal.aborted) setLoading(false); });
  };
  const seek = (value: number) => {
    if (!audio.current || !duration || !src || !Number.isFinite(value)) return;
    const next = Math.max(0, Math.min(duration, value));
    try { audio.current.currentTime = next; setTime(next); } catch { /* metadata not ready */ }
  };
  const pointerSeek = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width) seek((event.clientX - rect.left) / rect.width * duration);
  };
  return <div ref={root} className={`voice-note${failed ? " is-error" : ""}${playing ? " is-playing" : ""}`} title={`${label} · ${name}`} role="group" aria-busy={loading} aria-label={`Audio attachment: ${name}`}>
    <div className="voice-note-player">
      <button type="button" className="icon-button voice-note-play" disabled={uploading !== undefined || loading} aria-label={`${playing ? "Pause" : "Play"} ${accessibleLabel}, ${duration ? audioTime(duration) : "duration unknown"}`} onClick={play}>
        <span className="voice-action-face">{loading ? <span className="voice-spinner" /> : <Icon name={playing ? "pause" : "play"} size={14} />}</span>
      </button>
      <div className="voice-note-body">
        <span className="sr-only">{label}</span>
        {failed ? <div className="voice-note-failure"><span>Upload failed</span>{onRetry && <button type="button" className="attachment-retry" onClick={onRetry}>Retry upload</button>}</div> : <div className="voice-waveform" role="slider" tabIndex={0} aria-label={`Seek ${accessibleLabel}`} aria-valuemin={0} aria-valuemax={duration || 0} aria-valuenow={Math.min(time, duration)} aria-valuetext={`${audioTime(time)} of ${duration ? audioTime(duration) : "unknown duration"}`} aria-disabled={!src || !duration}
          onKeyDown={event => {
            let next: number;
            switch (event.key) {
              case "ArrowRight": case "ArrowUp": next = time + 5; break;
              case "ArrowLeft": case "ArrowDown": next = time - 5; break;
              case "Home": next = 0; break;
              case "End": next = duration; break;
              default: return;
            }
            event.preventDefault(); seek(next);
          }} onPointerDown={event => { if (!src || !duration) return; event.currentTarget.setPointerCapture(event.pointerId); pointerSeek(event); }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) pointerSeek(event); }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { pointerSeek(event); event.currentTarget.releasePointerCapture(event.pointerId); } }}>
          {Array.from({ length: 48 }, (_, index) => <i key={index} className={duration && index / 48 < time / duration ? "is-played" : undefined} style={{ height: `${3 + (waveform?.peaks[index] ?? 0) * 17}px` }} aria-hidden="true" />)}
        </div>}
      </div>
      {!failed && <span className="voice-note-time">{uploading !== undefined ? `${Math.round(uploading)}%` : <>{playing || time > 0 ? `${audioTime(time)} / ` : ""}{duration ? audioTime(duration) : "—:—"}</>}</span>}
      <div className="voice-note-actions">{actions}</div>
    </div>
    {uploading !== undefined && <div className="voice-upload"><span className="sr-only" role="status">Uploading {name}</span><progress value={uploading} max={100} aria-label={`Uploading ${name}`} /></div>}

    {ready && <p className="voice-ready" role="status">Tap to play</p>}
    {error && <p className="voice-error" role="status">{error}</p>}
    {caption && (caption.length > 240 ? <details className="voice-caption"><summary>Transcript</summary><p>{caption}</p></details> : <p className="voice-caption"><span className="sr-only">Transcript: </span>{caption}</p>)}
    <audio ref={audio} hidden preload="none" aria-label={`Audio ${name}`} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onTimeUpdate={() => setTime(audio.current?.currentTime ?? 0)} onDurationChange={() => { const value = audio.current?.duration; if (value && Number.isFinite(value)) setMediaDuration(value); }} onError={() => { setReady(false); setPlaying(false); setError("Audio preview unavailable. Use Download."); }} />
  </div>;
}
