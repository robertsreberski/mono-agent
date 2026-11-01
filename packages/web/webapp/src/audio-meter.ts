/** Normalized time-domain RMS; byte midpoint is silence, never a frequency bin. */
export function rmsAmplitude(data: Uint8Array): number {
  let sum = 0;
  for (const sample of data) sum += ((sample - 128) / 128) ** 2;
  return data.length ? Math.sqrt(sum / data.length) : 0;
}

/** Optional, capture-owned visualization. It never owns or stops stream tracks. */
export class AudioMeter {
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private analyser?: AnalyserNode;
  private frame?: number;
  private disposed = false;
  constructor(stream: MediaStream, update: (levels: readonly number[]) => void) {
    try {
      if (typeof AudioContext === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
      const context = new AudioContext();
      this.context = context;
      const analyser = context.createAnalyser();
      this.analyser = analyser;
      analyser.fftSize = 256;
      this.source = context.createMediaStreamSource(stream);
      this.source.connect(analyser); // Never connect microphone capture to speakers.
      this.resume();
      const data = new Uint8Array(analyser.fftSize);
      const history = Array<number>(24).fill(0.04);
      let amplitude = 0;
      let previous = 0;
      const sample = (time: number) => {
        if (this.disposed) return;
        try {
          if (time - previous >= 90) {
            previous = time;
            analyser.getByteTimeDomainData(data);
            amplitude = amplitude * 0.55 + Math.min(1, rmsAmplitude(data) * 3) * 0.45;
            history.shift(); history.push(Math.max(0.04, amplitude));
            update([...history]);
          }
          if (!this.disposed) this.frame = requestAnimationFrame(sample);
        } catch (error) { console.warn("Audio meter sampling stopped.", error); this.dispose(); }
      };
      this.frame = requestAnimationFrame(sample);
    } catch { this.dispose(); }
  }
  /** A later tap can resume a context suspended by mobile Safari. */
  resume(): void {
    try { if (this.context?.state === "suspended") void this.context.resume().catch(() => undefined); } catch { /* visualization is optional */ }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    try { this.source?.disconnect(); this.analyser?.disconnect(); } catch { /* already disconnected */ }
    try { void this.context?.close().catch(() => undefined); } catch { /* unavailable context */ }
    this.context = undefined;
  }
}
