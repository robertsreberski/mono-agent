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
      analyser.smoothingTimeConstant = 0.75;
      this.source = context.createMediaStreamSource(stream);
      this.source.connect(analyser); // Never connect microphone capture to speakers.
      this.resume();
      const data = new Uint8Array(analyser.frequencyBinCount);
      let previous = 0;
      const sample = (time: number) => {
        if (this.disposed) return;
        try {
          if (time - previous >= 80) {
            previous = time;
            analyser.getByteFrequencyData(data);
            update(Array.from({ length: 24 }, (_, index) => {
              const start = Math.floor(index * data.length / 24);
              const end = Math.max(start + 1, Math.floor((index + 1) * data.length / 24));
              let sum = 0;
              for (let i = start; i < end; i++) sum += data[i]!;
              return sum / (end - start) / 255;
            }));
          }
          if (!this.disposed) this.frame = requestAnimationFrame(sample);
        } catch { this.dispose(); }
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
