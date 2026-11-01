import { useEffect, useRef, useState, type ReactNode } from "react";
import { cachedWaveform, loadAudio, type Waveform } from "../audio-waveform";
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
  const audio = useRef<HTMLAudioElement>(null);
  const [waveform, setWaveform] = useState<Waveform | undefined>(() => cachedWaveform(id));
  const [src, setSrc] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [error, setError] = useState<string>();
  const owner = useRef<{ controller: AbortController; url?: string } | undefined>(undefined);
  useEffect(() => { const media = audio.current; return () => {
    owner.current?.controller.abort();
    if (media?.getAttribute("src")) { media.pause(); media.removeAttribute("src"); media.load(); }
    if (owner.current?.url) URL.revokeObjectURL(owner.current.url);
    owner.current = undefined;
  }; }, [id, file]);
  const duration = waveform?.duration ?? mediaDuration;
  const label = recorded || caption ? "Voice note" : name;
  const accessibleLabel = label === "Voice note" ? "voice note" : label;
  const play = () => {
    const media = audio.current;
    if (!media) return;
    if (playing) { media.pause(); return; }
    if (src) { void media.play().catch(() => setError("Playback unavailable. Try Play again or download.")); return; }
    if (loading) return;
    const task = { controller: new AbortController(), url: undefined as string | undefined };
    owner.current = task; setLoading(true); setError(undefined);
    void loadAudio(id, file, contentType, task.controller.signal).then(result => {
      if (task.controller.signal.aborted) return;
      task.url = URL.createObjectURL(result.blob); setSrc(task.url); setWaveform(result.waveform);
      media.src = task.url;
      // Some mobile browsers require a second explicit gesture after loading.
      void media.play().catch(() => undefined);
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
  return <div className={`voice-note${failed ? " is-error" : ""}${playing ? " is-playing" : ""}`} role="group" aria-busy={loading} aria-label={`Audio attachment: ${name}`}>
    <div className="voice-note-player">
      <button type="button" className="icon-button voice-note-play" disabled={uploading !== undefined || loading} aria-label={`${playing ? "Pause" : "Play"} ${accessibleLabel}, ${duration ? audioTime(duration) : "duration unknown"}`} onClick={play}>
        {loading ? <span className="voice-spinner" /> : <Icon name={playing ? "pause" : "play"} size={18} />}
      </button>
      <div className="voice-note-body">
        <div className="voice-note-heading"><span title={name}>{label}</span><span className="voice-note-time">{playing || time > 0 ? `${audioTime(time)} / ` : ""}{duration ? audioTime(duration) : "—:—"}</span></div>
        <div className="voice-waveform" role="slider" tabIndex={0} aria-label={`Seek ${accessibleLabel}`} aria-valuemin={0} aria-valuemax={duration || 0} aria-valuenow={Math.min(time, duration)} aria-valuetext={`${audioTime(time)} of ${duration ? audioTime(duration) : "unknown duration"}`} aria-disabled={!src || !duration}
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
          {Array.from({ length: 48 }, (_, index) => <i key={index} className={duration && index / 48 < time / duration ? "is-played" : undefined} style={{ height: `${3 + (waveform?.peaks[index] ?? 0) * 25}px` }} aria-hidden="true" />)}
        </div>
      </div>
      <div className="voice-note-actions">{actions}</div>
    </div>
    {uploading !== undefined && <div className="voice-upload" role="status"><span>Uploading · {Math.round(uploading)}%</span><progress value={uploading} max={100} aria-label={`Uploading ${name}`} /></div>}
    {failed && <div className="voice-upload voice-upload-failed"><span>Upload failed</span>{onRetry && <button type="button" className="voice-retry" onClick={onRetry}><Icon name="refresh" size={14} />Retry upload</button>}</div>}
    {error && <p className="voice-error" role="status">{error}</p>}
    {caption && (caption.length > 240 ? <details className="voice-caption"><summary>Transcript</summary><p>{caption}</p></details> : <p className="voice-caption"><span className="sr-only">Transcript: </span>{caption}</p>)}
    <audio ref={audio} hidden preload="none" aria-label={`Audio ${name}`} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onTimeUpdate={() => setTime(audio.current?.currentTime ?? 0)} onDurationChange={() => { const value = audio.current?.duration; if (value && Number.isFinite(value)) setMediaDuration(value); }} onError={() => { setPlaying(false); setError("Audio preview unavailable. Use Download."); }} />
  </div>;
}
