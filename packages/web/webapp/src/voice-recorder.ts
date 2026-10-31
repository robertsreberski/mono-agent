export const VOICE_MAX_BYTES = 10 * 1024 * 1024;
export const VOICE_MAX_SECONDS = 120;
const CANDIDATES = ["audio/webm;codecs=opus", "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/ogg;codecs=opus"] as const;

export function chooseRecordingType(recorder: Pick<typeof MediaRecorder, "isTypeSupported">): string | undefined {
  if (typeof recorder.isTypeSupported !== "function") return undefined;
  return CANDIDATES.find((type) => {
    try { return recorder.isTypeSupported(type); } catch { return false; }
  });
}

export function voiceUnavailableReason(): string | undefined {
  if (!window.isSecureContext) return "Microphone access needs HTTPS or localhost. Open the console securely.";
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return "This browser cannot record audio. Use a current supported browser.";
  if (!chooseRecordingType(MediaRecorder)) return "This browser has no supported WebM, MP4 or Ogg recorder.";
  return undefined;
}

interface RecorderCallbacks {
  readonly recording: () => void;
  readonly elapsed: (seconds: number) => void;
  readonly ready: (audio: Blob) => void;
  readonly error: (message: string) => void;
}

/** All audio is ephemeral; no preview URL, storage or file upload is created. */
export class VoiceRecorder {
  private disposed = false;
  private stream?: MediaStream;
  private recorder?: MediaRecorder;
  private timer?: ReturnType<typeof setInterval>;
  private chunks: Blob[] = [];
  private bytes = 0;
  private readonly callbacks: RecorderCallbacks;
  constructor(callbacks: RecorderCallbacks) { this.callbacks = callbacks; }

  async start(): Promise<void> {
    try {
      const mimeType = chooseRecordingType(MediaRecorder);
      if (!mimeType) throw new Error("unsupported");
      // Called only from the explicit Record click handler.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (this.disposed) { stream.getTracks().forEach((track) => track.stop()); return; }
      this.stream = stream;
      const recorder = new MediaRecorder(stream, { mimeType });
      this.recorder = recorder;
      recorder.ondataavailable = (event) => {
        if (this.disposed) return;
        this.bytes += event.data.size;
        if (this.bytes > VOICE_MAX_BYTES) { this.fail("Recording exceeds 10 MiB. Record a shorter message."); return; }
        if (event.data.size) this.chunks.push(event.data);
      };
      recorder.onerror = () => this.fail("Recording failed. Check microphone access and record again.");
      recorder.onstop = () => {
        this.releaseCapture();
        if (this.disposed) return;
        const type = recorder.mimeType || this.chunks.find((chunk) => chunk.type)?.type || mimeType;
        if (!/^audio\/(webm|mp4|ogg)(?:;|$)/iu.test(type)) { this.fail("The browser produced an unsupported audio format."); return; }
        const audio = new Blob(this.chunks, { type });
        this.chunks = [];
        if (!audio.size) { this.fail("The recording is empty. Record again."); return; }
        this.callbacks.ready(audio);
      };
      recorder.start(250);
      this.callbacks.recording();
      const start = performance.now();
      this.timer = setInterval(() => {
        const seconds = Math.min(VOICE_MAX_SECONDS, Math.floor((performance.now() - start) / 1000));
        this.callbacks.elapsed(seconds);
        if (seconds >= VOICE_MAX_SECONDS) this.stop();
      }, 200);
    } catch (error) {
      if (this.disposed) return;
      this.fail(error instanceof DOMException && ["NotAllowedError", "SecurityError"].includes(error.name)
        ? "Microphone permission denied. Allow microphone access in browser settings, then record again."
        : "Microphone unavailable. Check the device and browser, then record again.");
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.recorder?.state !== "inactive") this.recorder?.stop();
    this.releaseCapture();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    if (this.recorder) {
      this.recorder.ondataavailable = null;
      this.recorder.onstop = null;
      this.recorder.onerror = null;
    }
    this.chunks = [];
    this.recorder = undefined;
    this.stream = undefined;
  }
  private releaseCapture(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
  }
  private fail(message: string): void {
    this.dispose();
    this.callbacks.error(message);
  }
}
