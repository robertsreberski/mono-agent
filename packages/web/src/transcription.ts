import { WebConsoleError } from "./errors.js";
import type { WebVoiceConfig } from "./voice-config.js";

export const WEB_VOICE_LIMITS = { maxBytes: 10 * 1024 * 1024, maxTextCharacters: 8000 } as const;
export const WEB_VOICE_UPLOAD_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface VoiceFormat { readonly mediaType: string; readonly extension: string }

/** Accept MediaRecorder's realistic MIME parameters, never arbitrary multipart input. */
export function voiceFormat(value: string | undefined): VoiceFormat {
  const match = /^(audio\/(?:webm|mp4|ogg))(?:\s*;\s*codecs\s*=\s*"?([a-zA-Z0-9., -]+)"?)?\s*$/iu.exec(value ?? "");
  const type = match?.[1]?.toLowerCase();
  const codecs = match?.[2]?.toLowerCase().split(",").map((codec) => codec.trim());
  const allowed = type === "audio/mp4" ? /^(?:mp4a\.40\.[25]|aac|alac|opus)$/u : /^(?:opus|vorbis)$/u;
  if (type === undefined || codecs?.some((codec) => !allowed.test(codec))) {
    throw new WebConsoleError("voice_format_unsupported", "Record audio as WebM, MP4 or Ogg with a supported audio codec.", 415);
  }
  return { mediaType: type, extension: type === "audio/mp4" ? "m4a" : type === "audio/webm" ? "webm" : "ogg" };
}

export function validateVoiceAudio(audio: Uint8Array, format: VoiceFormat): void {
  if (audio.length === 0) throw new WebConsoleError("voice_empty", "The recording is empty. Record again.", 400);
  if (audio.length > WEB_VOICE_LIMITS.maxBytes) throw new WebConsoleError("voice_too_large", "The recording exceeds 10 MiB. Record a shorter message.", 413);
  const prefix = Buffer.from(audio.buffer, audio.byteOffset, Math.min(audio.length, 12));
  const valid = format.mediaType === "audio/webm" ? prefix.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
    : format.mediaType === "audio/ogg" ? prefix.subarray(0, 4).toString("ascii") === "OggS"
      : prefix.length >= 12 && prefix.subarray(4, 8).toString("ascii") === "ftyp";
  if (!valid) throw new WebConsoleError("voice_container_invalid", "The recording does not match its audio format. Record again in a supported browser.", 415);
}

export interface VoiceOperation {
  readonly signal: AbortSignal;
  abort(): void;
  transcribe(audio: Uint8Array, format: VoiceFormat): Promise<{ readonly text: string }>;
  release(): void;
}

/** Ephemeral reservations include upload time. There is deliberately no queue or audio store. */
export class WebTranscriptions {
  private readonly active = new Map<string, AbortController>();
  private stopped = false;
  constructor(private readonly config: WebVoiceConfig | undefined, private readonly fetchImpl: typeof fetch = fetch) {}
  get enabled(): boolean { return this.config !== undefined; }
  reserve(threadId: string): VoiceOperation {
    if (!this.config) throw new WebConsoleError("voice_disabled", "Voice messages are not configured on this console.", 409);
    if (this.stopped) throw new WebConsoleError("web_service_stopping", "The web service is stopping.", 409);
    if (this.active.has(threadId) || this.active.size >= 2) throw new WebConsoleError("voice_busy", "Another recording is being processed. Wait and retry Send.", 429);
    const controller = new AbortController();
    this.active.set(threadId, controller);
    const config = this.config;
    let released = false;
    return {
      signal: controller.signal,
      abort: () => controller.abort(),
      transcribe: async (audio, format) => {
        if (released) throw new WebConsoleError("voice_cancelled", "Voice message cancelled.", 409);
        validateVoiceAudio(audio, format);
        const timeout = setTimeout(() => controller.abort(new Error("timeout")), config.transcription.timeoutMs ?? 120_000);
        try {
          controller.signal.throwIfAborted();
          const body = new FormData();
          body.append("file", new Blob([Uint8Array.from(audio)], { type: format.mediaType }), `recording.${format.extension}`);
          body.append("model", config.transcription.model);
          if (config.transcription.language) body.append("language", config.transcription.language);
          const response = await this.fetchImpl(config.transcription.endpoint, { method: "POST", body, redirect: "error", signal: controller.signal });
          if (!response.ok || !response.body) throw new Error("provider");
          const declared = Number(response.headers.get("content-length"));
          if (declared > MAX_RESPONSE_BYTES) { await response.body.cancel(); throw new Error("size"); }
          const reader = response.body.getReader();
          let size = 0;
          const chunks: Uint8Array[] = [];
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              size += next.value.byteLength;
              if (size > MAX_RESPONSE_BYTES) throw new Error("size");
              chunks.push(next.value);
            }
          } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
          const result = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { text?: unknown };
          const text = typeof result?.text === "string" ? result.text.trim() : "";
          if (!text || text.length > WEB_VOICE_LIMITS.maxTextCharacters) throw new Error("text");
          return { text };
        } catch {
          if (controller.signal.aborted) throw new WebConsoleError("voice_aborted", "Transcription cancelled or timed out. Retry Send if you still want to send it.", 408);
          throw new WebConsoleError("voice_provider_failed", "Transcription failed. Check the local service supports this recording format, then retry Send.", 502);
        } finally { clearTimeout(timeout); }
      },
      release: () => {
        if (released) return;
        released = true;
        controller.abort();
        if (this.active.get(threadId) === controller) this.active.delete(threadId);
      },
    };
  }
  stop(): void {
    this.stopped = true;
    for (const controller of this.active.values()) controller.abort();
  }
}
