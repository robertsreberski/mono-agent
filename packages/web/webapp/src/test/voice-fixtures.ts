import { vi } from "vitest";

/** Synthetic fixture only: these bytes exercise lifecycle, not audio decoding. */
export class FixtureMediaRecorder {
  static supported = ["audio/webm;codecs=opus"];
  static instances: FixtureMediaRecorder[] = [];
  static isTypeSupported(type: string) { return this.supported.includes(type); }
  state: RecordingState = "inactive";
  mimeType: string;
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_stream: MediaStream, options: MediaRecorderOptions) {
    this.mimeType = options.mimeType ?? "audio/webm";
    FixtureMediaRecorder.instances.push(this);
  }
  start() { this.state = "recording"; }
  stop() {
    this.state = "inactive";
    queueMicrotask(() => {
      this.chunk(new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3])], { type: this.mimeType }));
      this.onstop?.();
    });
  }
  chunk(data: Blob) { this.ondataavailable?.({ data } as BlobEvent); }
}

export function installVoiceFixture(permission?: () => Promise<MediaStream>) {
  const stop = vi.fn();
  const stream = { getTracks: () => [{ stop }, { stop }] } as unknown as MediaStream;
  const getUserMedia = vi.fn(permission ?? (async () => stream));
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("MediaRecorder", FixtureMediaRecorder);
  FixtureMediaRecorder.supported = ["audio/webm;codecs=opus"];
  FixtureMediaRecorder.instances = [];
  return { stop, stream, getUserMedia, restore: () => {
    if (descriptor) Object.defineProperty(navigator, "mediaDevices", descriptor);
    else Reflect.deleteProperty(navigator, "mediaDevices");
    vi.unstubAllGlobals();
  } };
}
