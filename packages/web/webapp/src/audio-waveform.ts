import { VOICE_MAX_BYTES } from "./voice-recorder";

// Peaks accept 2 MiB (about 8/4 minutes at 32/64 kbit/s); playback accepts 10 MiB.
// Design floor: >= 6 kbit/s (Opus nominal minimum; recorder/AAC rates are higher).
// 2 MiB / 750 B/s = 2796.2s; 3000Hz * stereo * 4-byte Float32 = 67,108,864 B
// (~67 MB / 64 MiB) for the SINGLE native decode lease, including after timeout.
// Extreme DTX/ultra-low-bitrate files are an accepted residual: owner-only uploads
// decoded in the owner's local tab, not an absolute memory/security guarantee.
export const WAVEFORM_MAX_BYTES = 2 * 1024 * 1024;
const PEAK_SAMPLE_RATE = 3000;

export interface Waveform { readonly peaks: readonly number[]; readonly duration: number; }
/** Max absolute amplitude in each bucket, across every channel (including tails). */
export function extractPeaks(channels: readonly Float32Array[], count = 48): number[] {
  const length = channels[0]?.length ?? 0;
  return Array.from({ length: count }, (_, bucket) => {
    let peak = 0;
    const start = Math.floor(bucket * length / count);
    const end = Math.min(length, Math.max(start + 1, Math.floor((bucket + 1) * length / count)));
    for (const channel of channels) for (let i = start; i < end; i++) peak = Math.max(peak, Math.abs(channel[i] ?? 0));
    return Math.min(1, peak);
  });
}

/** One bounded loader per application. A factory also lets tests use cold caches. */
export function createAudioLoader() {
  // Only compact peaks are retained, never blobs/URLs/decoded PCM. Bounded LRU.
  const cache = new Map<string, Waveform | null>();
  // Serialize ordinary fetch/decode work so concurrent previews wait, not skip.
  let active = 0;
  let decoders = 0;
  const queue: (() => void)[] = [];
  type Loaded = { blob: Blob; waveform?: Waveform };
  type Pending = { controller: AbortController; users: number; promise: Promise<Loaded> };
  // Only live consumers retain this temporary blob; settled entries are removed.
  const pending = new Map<string, Pending>();
  function release() { const next = queue.shift(); if (next) next(); else active--; }
  async function slot(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (active >= 1) await new Promise<void>((resolve, reject) => {
      const enter = () => { signal.removeEventListener("abort", abort); resolve(); };
      const abort = () => { const index = queue.indexOf(enter); if (index >= 0) queue.splice(index, 1); reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true }); queue.push(enter);
    });
    // A released slot is reserved for the queued waiter before yielding.
    else active++;
    if (signal.aborted) { release(); signal.throwIfAborted(); }
    return release;
  }
  function remember(id: string, value: Waveform | null) {
    cache.delete(id); cache.set(id, value);
    if (cache.size > 32) cache.delete(cache.keys().next().value!);
  }
  function cachedWaveform(id: string): Waveform | undefined {
    const value = cache.get(id);
    if (value !== undefined) { cache.delete(id); cache.set(id, value); }
    return value ?? undefined;
  }
  async function bounded<T>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let done: (() => void) | undefined;
    try { done = await slot(controller.signal); return await work(controller.signal); }
    finally { done?.(); clearTimeout(timeout); signal.removeEventListener("abort", abort); }
  }
  async function decodeCached(id: string, blob: Blob, signal: AbortSignal): Promise<Waveform | undefined> {
    const cached = cachedWaveform(id);
    if (cache.has(id)) return cached;
    const result = await decode(blob, signal);
    signal.throwIfAborted();
    // Saturation is not a codec failure: a later visibility/Play attempt may retry.
    if (result.cacheable) remember(id, result.waveform ?? null);
    return result.waveform;
  }
  async function decode(blob: Blob, signal: AbortSignal): Promise<{ waveform?: Waveform; cacheable: boolean }> {
    // Deliberate budget skips are retryable, not negatively cached codec failures.
    if (blob.size > WAVEFORM_MAX_BYTES || decoders >= 1) return { cacheable: false };
    if (typeof OfflineAudioContext === "undefined" && typeof AudioContext === "undefined") return { cacheable: true };
    let context: AudioContext | OfflineAudioContext | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      context = typeof OfflineAudioContext !== "undefined" ? new OfflineAudioContext(1, 1, PEAK_SAMPLE_RATE) : new AudioContext({ sampleRate: PEAK_SAMPLE_RATE });
      // Some implementations ignore requested rates. Never decode at a device rate.
      if (context.sampleRate !== PEAK_SAMPLE_RATE) return { cacheable: false };
      const interrupted = new Promise<never>((_, reject) => {
        abort = () => reject(new DOMException("Decode cancelled", "AbortError"));
        signal.addEventListener("abort", abort, { once: true }); timer = setTimeout(abort, 8_000);
      });
      signal.throwIfAborted();
      // Native decode has no cancellation API. A timeout retains its decoder
      // lease until it really settles, so orphaned decodes cannot accumulate.
      decoders++;
      const decoding = Promise.resolve().then(() => blob.arrayBuffer()).then(bytes => context!.decodeAudioData(bytes)).finally(() => { decoders--; });
      const buffer = await Promise.race([decoding, interrupted]);
      if (!Number.isFinite(buffer.duration) || buffer.duration <= 0) return { cacheable: true };
      return { cacheable: true, waveform: { duration: buffer.duration, peaks: extractPeaks(Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i))) } };
    } catch { return { cacheable: true }; } // Missing peaks never prevent playback.
    finally {
      clearTimeout(timer); if (abort) signal.removeEventListener("abort", abort);
      // Offline contexts have no realtime device and no close().
      try { if (context && "close" in context) void context.close().catch(() => undefined); } catch { /* already closed */ }
    }
  }
  function sharedLoad(id: string, file: File | undefined, type: string, signal: AbortSignal): Promise<Loaded> {
    signal.throwIfAborted();
    let task = pending.get(id);
    if (!task) {
      const controller = new AbortController();
      const entry: Pending = { controller, users: 0, promise: bounded(controller.signal, async signal => {
        const blob = await audioBlob(id, file, type, signal);
        signal.throwIfAborted(); const waveform = await decodeCached(id, blob, signal);
        signal.throwIfAborted(); return { blob, ...(waveform ? { waveform } : {}) };
      }).finally(() => { if (pending.get(id) === entry) pending.delete(id); }) };
      pending.set(id, entry); task = entry;
    }
    const entry = task;
    entry.users++;
    return new Promise<Loaded>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        settled = true; signal.removeEventListener("abort", abort);
        if (--entry.users === 0) {
          if (pending.get(id) === entry) pending.delete(id);
          entry.controller.abort();
        }
      };
      const abort = () => { if (!settled) { finish(); reject(signal.reason); } };
      signal.addEventListener("abort", abort, { once: true });
      entry.promise.then(value => { if (!settled) { finish(); resolve(value); } }, error => { if (!settled) { finish(); reject(error); } });
      if (signal.aborted) abort();
    });
  }
  /** Visibility/local-file previews discard their blob as soon as peaks exist. */
  async function prepareWaveform(id: string, file: File | undefined, type: string, signal: AbortSignal): Promise<Waveform | undefined> {
    signal.throwIfAborted();
    if (cache.has(id)) return cachedWaveform(id);
    if (file && file.size > WAVEFORM_MAX_BYTES) return undefined;
    return (await sharedLoad(id, file, type, signal)).waveform;
  }
  /** Concurrent preview/Play share work; later Play may fetch again (no blob cache). */
  async function loadAudio(id: string, file: File | undefined, type: string, signal: AbortSignal): Promise<Loaded> {
    return sharedLoad(id, file, type, signal);
  }
  return { cachedWaveform, prepareWaveform, loadAudio };
}
const loader = createAudioLoader();
export const { cachedWaveform, prepareWaveform, loadAudio } = loader;

async function audioBlob(id: string, file: File | undefined, contentType: string, signal: AbortSignal): Promise<Blob> {
  if (file) { if (file.size > VOICE_MAX_BYTES) throw new Error("Download this file to play it."); return file; }
  const response = await fetch(`/api/v1/uploads/${encodeURIComponent(id)}/content`, { signal });
  if (!response.ok || !response.body) throw new Error("Audio preview unavailable. Use Download.");
  if (Number(response.headers.get("Content-Length")) > VOICE_MAX_BYTES) { await response.body.cancel(); throw new Error("Download this file to play it."); }
  const reader = response.body.getReader(); const chunks: Uint8Array<ArrayBuffer>[] = []; let size = 0;
  try {
    while (true) {
      signal.throwIfAborted(); const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > VOICE_MAX_BYTES) throw new Error("Download this file to play it.");
      chunks.push(Uint8Array.from(next.value));
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  return new Blob(chunks, { type: contentType });
}
