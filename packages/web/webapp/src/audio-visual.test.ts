import { Blob as ReadableBlob } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioMeter, rmsAmplitude } from "./audio-meter";
import { cachedWaveform, createAudioLoader, extractPeaks, loadAudio, WAVEFORM_MAX_BYTES } from "./audio-waveform";
import { VoiceRecorder } from "./voice-recorder";
import { FixtureMediaRecorder, installVoiceFixture } from "./test/voice-fixtures";
import { presentTranscripts } from "./voice-transcripts";

function contextFixture() {
  const close = vi.fn(async () => {}); const disconnect = vi.fn(); const resume = vi.fn(async () => {});
  const decodeAudioData = vi.fn(async (_bytes: ArrayBuffer) => ({ duration: 7, numberOfChannels: 1, getChannelData: () => new Float32Array([0, 0.5, -1, 0.2]) }));
  vi.stubGlobal("AudioContext", class {
    sampleRate = 3000; state = "suspended"; close = close; resume = resume; decodeAudioData = decodeAudioData;
    createAnalyser() { return { frequencyBinCount: 128, connect: vi.fn(), getByteTimeDomainData: (data: Uint8Array) => data.fill(192), disconnect }; }
    createMediaStreamSource() { return { connect: vi.fn(), disconnect }; }
  });
  const frames = new Map<number, FrameRequestCallback>(); let next = 0;
  vi.stubGlobal("requestAnimationFrame", vi.fn((fn: FrameRequestCallback) => { frames.set(++next, fn); return next; }));
  const cancel = vi.fn((id: number) => frames.delete(id)); vi.stubGlobal("cancelAnimationFrame", cancel);
  return { close, disconnect, resume, decodeAudioData, frames, cancel };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("optional capture meter ownership", () => {
  it.each(["stop", "cancel", "dispose", "error"])("closes context and cancels the frame on %s", async action => {
    const fixture = installVoiceFixture(); const context = contextFixture();
    const levels = vi.fn(); const ready = vi.fn(); const error = vi.fn();
    const recorder = new VoiceRecorder({ levels, ready, error, recording: vi.fn(), elapsed: vi.fn() });
    await recorder.start(); expect(context.resume).toHaveBeenCalledTimes(1);
    const callback = [...context.frames.values()][0]!; context.frames.clear(); callback(100);
    expect(levels).toHaveBeenCalledWith([...Array(23).fill(0.04), 0.45]);
    if (action === "stop") recorder.stop();
    else if (action === "error") FixtureMediaRecorder.instances[0]!.onerror?.();
    else recorder.dispose();
    await Promise.resolve();
    expect(context.frames.size).toBe(0); expect(context.cancel).toHaveBeenCalled(); expect(context.close).toHaveBeenCalledTimes(1);
    expect(fixture.stop).toHaveBeenCalledTimes(2);
    recorder.dispose(); fixture.restore();
  });
  it.each(["missing", "constructor", "source"])("still records if Web Audio is %s/unavailable", async mode => {
    const fixture = installVoiceFixture();
    const close = vi.fn(async () => {});
    vi.stubGlobal("AudioContext", mode === "missing" ? undefined : class {
      constructor() { if (mode === "constructor") throw Error("unavailable"); }
      close = close;
      createAnalyser() { throw Error("unsupported"); }
    });
    const ready = vi.fn(); const error = vi.fn(); const recorder = new VoiceRecorder({ levels: vi.fn(), ready, error, recording: vi.fn(), elapsed: vi.fn() });
    await recorder.start(); recorder.stop(); await Promise.resolve();
    expect(ready).toHaveBeenCalledTimes(1); expect(error).not.toHaveBeenCalled();
    if (mode === "source") expect(close).toHaveBeenCalledTimes(1);
    recorder.dispose(); fixture.restore();
  });
  it("uses time-domain RMS and rolls a quiet amplitude history from the right", () => {
    expect(rmsAmplitude(new Uint8Array([128, 128]))).toBe(0);
    expect(rmsAmplitude(new Uint8Array([64, 192]))).toBe(0.5);
    const context = contextFixture(); const update = vi.fn();
    const meter = new AudioMeter({} as MediaStream, update);
    for (const time of [100, 200]) { const callback = [...context.frames.values()][0]!; context.frames.clear(); callback(time); }
    expect(update.mock.calls[1]![0].slice(0, 22)).toEqual(Array(22).fill(0.04));
    expect(update.mock.calls[1]![0].slice(22)).toEqual([0.45, expect.closeTo(0.6975)]);
    meter.dispose();
  });
  it("warns once and disposes non-fatally when a sampling callback throws", () => {
    const context = contextFixture(); const error = new Error("Synthetic callback failure");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const meter = new AudioMeter({} as MediaStream, () => { throw error; });
    const callback = [...context.frames.values()][0]!; context.frames.clear();
    expect(() => callback(100)).not.toThrow(); callback(200);
    expect(warn).toHaveBeenCalledExactlyOnceWith("Audio meter sampling stopped.", error);
    expect(context.close).toHaveBeenCalledOnce(); expect(context.frames.size).toBe(0);
    meter.dispose();
  });
  it("is static under reduced motion", () => {
    const context = contextFixture(); vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const meter = new AudioMeter({} as MediaStream, vi.fn()); meter.dispose();
    expect(context.frames.size).toBe(0); expect(context.close).not.toHaveBeenCalled();
  });
});

describe("bounded waveform preparation", () => {
  it("downsamples absolute peaks across channels and includes the tail", () => {
    expect(extractPeaks([new Float32Array([0, -0.8, 0.1, 0, 0.3]), new Float32Array([0.4, 0, 0, 0, -1])], 2)).toEqual([expect.closeTo(0.8), 1]);
    expect(extractPeaks([], 3)).toEqual([0, 0, 0]);
  });
  const blob = () => ({ size: 3, arrayBuffer: async () => new ArrayBuffer(3) }) as File;
  it("reuses cached peaks, closes decode contexts and does not fetch local audio", async () => {
    const context = contextFixture(); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    const first = await loadAudio("cache-test", blob(), "audio/webm", signal);
    const second = await loadAudio("cache-test", blob(), "audio/webm", signal);
    expect(first.waveform?.duration).toBe(7); expect(second.waveform).toBe(first.waveform);
    expect(cachedWaveform("cache-test")).toBe(first.waveform);
    expect(context.decodeAudioData).toHaveBeenCalledTimes(1); expect(context.close).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
  });
  it("prepares local peaks eagerly and reuses them for sent notes without fetching", async () => {
    const context = contextFixture(); const loader = createAudioLoader(); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    const prepared = await loader.prepareWaveform("local-preview", blob(), "audio/webm", signal);
    expect(prepared?.duration).toBe(7);
    expect(await loader.prepareWaveform("local-preview", undefined, "audio/webm", signal)).toBe(prepared);
    expect(context.decodeAudioData).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
  });
  it("decodes a realistic 480KB two-minute note instead of treating it as over budget", async () => {
    const context = contextFixture(); const loader = createAudioLoader(); const signal = new AbortController().signal;
    context.decodeAudioData.mockResolvedValue({ duration: 120, numberOfChannels: 1, getChannelData: () => new Float32Array([0.1, 0.7, -0.5]) });
    const file = { size: 480_000, arrayBuffer: async () => new ArrayBuffer(480_000) } as File;
    const waveform = await loader.prepareWaveform("two-minute-note", file, "audio/webm", signal);
    expect(waveform?.duration).toBe(120); expect(waveform?.peaks.some(peak => peak > 0.5)).toBe(true);
    expect(context.decodeAudioData).toHaveBeenCalledOnce();
    expect(context.decodeAudioData.mock.calls[0]![0].byteLength).toBe(480_000);
    expect((await loader.loadAudio("two-minute-note", file, "audio/webm", signal)).blob).toBe(file);
    expect(context.decodeAudioData).toHaveBeenCalledOnce();
  });
  it("remembers immutable over-budget preview size without blocking Play", async () => {
    const context = contextFixture(); const loader = createAudioLoader(); const signal = new AbortController().signal;
    const large = { size: WAVEFORM_MAX_BYTES + 1, arrayBuffer: vi.fn() } as unknown as File;
    expect(await loader.prepareWaveform("decode-budget", large, "audio/webm", signal)).toBeUndefined();
    const result = await loader.loadAudio("decode-budget", large, "audio/webm", signal);
    expect(result.blob).toBe(large); expect(result.waveform).toBeUndefined();
    expect(large.arrayBuffer).not.toHaveBeenCalled(); expect(context.decodeAudioData).not.toHaveBeenCalled();
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(await loader.prepareWaveform("decode-budget", undefined, "audio/webm", signal)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect((await loader.loadAudio("different-small-note", blob(), "audio/webm", signal)).waveform?.duration).toBe(7);
    expect(context.decodeAudioData).toHaveBeenCalledOnce();
  });
  it("also skips over-budget remote decoding when automatic preparation overlaps Play", async () => {
    const context = contextFixture(); const loader = createAudioLoader(); vi.stubGlobal("Blob", ReadableBlob);
    const fetch = vi.fn(async () => new Response(new Uint8Array(WAVEFORM_MAX_BYTES + 1))); vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    const [preview, playback] = await Promise.all([
      loader.prepareWaveform("large-remote", undefined, "audio/ogg", signal),
      loader.loadAudio("large-remote", undefined, "audio/ogg", signal),
    ]);
    expect(preview).toBeUndefined(); expect(playback.waveform).toBeUndefined();
    expect(playback.blob.size).toBe(WAVEFORM_MAX_BYTES + 1);
    expect(context.decodeAudioData).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([false, true])("does not time out >30s queue wait (Play joins queued preview: %s)", async joinPlay => {
    vi.useFakeTimers(); contextFixture(); vi.stubGlobal("Blob", ReadableBlob); const loader = createAudioLoader();
    const pending: { resolve: (response: Response) => void; signal: AbortSignal }[] = [];
    const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>(resolve => pending.push({ resolve, signal: init!.signal! }))); vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    const first = loader.prepareWaveform("wait-first", undefined, "audio/ogg", signal);
    const second = loader.prepareWaveform("wait-second", undefined, "audio/ogg", signal);
    const preview = loader.prepareWaveform("wait-target", undefined, "audio/ogg", signal);
    let completed = false; void preview.then(() => { completed = true; }, () => { completed = true; });
    await vi.advanceTimersByTimeAsync(20_000);
    pending[0]!.resolve(new Response(new Uint8Array([1, 2, 3]))); await first;
    const play = joinPlay ? loader.loadAudio("wait-target", undefined, "audio/ogg", signal) : undefined;
    await vi.advanceTimersByTimeAsync(20_000); // Target has spent 40s in the queue.
    expect(completed).toBe(false); expect(pending[1]!.signal.aborted).toBe(false);
    pending[1]!.resolve(new Response(new Uint8Array([1, 2, 3]))); await second;
    expect(pending).toHaveLength(3); expect(pending[2]!.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000); // Fresh active budget, not an expired queue budget.
    pending[2]!.resolve(new Response(new Uint8Array([1, 2, 3])));
    expect((await preview)?.duration).toBe(7);
    if (play) expect((await play).waveform?.duration).toBe(7);
  });
  it("rejects an oversized preview by Content-Length before reading and caches the size skip", async () => {
    const context = contextFixture(); const loader = createAudioLoader(); const pull = vi.fn(); const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const fetch = vi.fn(async () => new Response(body, { headers: { "Content-Length": String(WAVEFORM_MAX_BYTES + 1) } })); vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    expect(await loader.prepareWaveform("header-large", undefined, "audio/ogg", signal)).toBeUndefined();
    expect(pull).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce();
    expect(context.decodeAudioData).not.toHaveBeenCalled();
    expect(await loader.prepareWaveform("header-large", undefined, "audio/ogg", signal)).toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("retains known immutable oversize metadata if the owner leaves during stream cancellation", async () => {
    contextFixture(); const loader = createAudioLoader(); const owner = new AbortController();
    const body = new ReadableStream({ cancel() { owner.abort(); } }, { highWaterMark: 0 });
    const fetch = vi.fn(async () => new Response(body, { headers: { "Content-Length": String(WAVEFORM_MAX_BYTES + 1) } })); vi.stubGlobal("fetch", fetch);
    await expect(loader.prepareWaveform("cancel-large", undefined, "audio/ogg", owner.signal)).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve(); await Promise.resolve();
    expect(await loader.prepareWaveform("cancel-large", undefined, "audio/ogg", new AbortController().signal)).toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("cancels a streamed preview at the first byte beyond its cap, without reading the rest", async () => {
    const context = contextFixture(); const loader = createAudioLoader(); const cancel = vi.fn();
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      reads++;
      if (reads === 1) controller.enqueue(new Uint8Array(WAVEFORM_MAX_BYTES));
      else if (reads === 2) controller.enqueue(new Uint8Array(1));
      else controller.enqueue(new Uint8Array(6 * 1024 * 1024));
    }, cancel }, { highWaterMark: 0 });
    const fetch = vi.fn(async () => new Response(body)); vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    expect(await loader.prepareWaveform("stream-large", undefined, "audio/ogg", signal)).toBeUndefined();
    expect(reads).toBe(2); expect(cancel).toHaveBeenCalledOnce(); expect(context.decodeAudioData).not.toHaveBeenCalled();
    await loader.prepareWaveform("stream-large", undefined, "audio/ogg", signal);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("upgrades an in-flight preview to Play's full byte budget", async () => {
    const context = contextFixture(); vi.stubGlobal("Blob", ReadableBlob); const loader = createAudioLoader();
    let resolve!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(done => { resolve = done; })); vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    const preview = loader.prepareWaveform("upgrade-large", undefined, "audio/ogg", signal);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const play = loader.loadAudio("upgrade-large", undefined, "audio/ogg", signal);
    resolve(new Response(new Uint8Array(3 * 1024 * 1024), { headers: { "Content-Length": String(3 * 1024 * 1024) } }));
    expect(await preview).toBeUndefined(); expect((await play).blob.size).toBe(3 * 1024 * 1024);
    expect(fetch).toHaveBeenCalledOnce(); expect(context.decodeAudioData).not.toHaveBeenCalled();
    await loader.prepareWaveform("upgrade-large", undefined, "audio/ogg", signal);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("restores the preview cap if the only Play subscriber cancels", async () => {
    contextFixture(); const loader = createAudioLoader(); let resolve!: (response: Response) => void;
    const cancel = vi.fn(); const fetch = vi.fn(() => new Promise<Response>(done => { resolve = done; })); vi.stubGlobal("fetch", fetch);
    const preview = loader.prepareWaveform("downgrade", undefined, "audio/ogg", new AbortController().signal);
    const owner = new AbortController(); const play = loader.loadAudio("downgrade", undefined, "audio/ogg", owner.signal);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const rejection = expect(play).rejects.toMatchObject({ name: "AbortError" }); owner.abort(); await rejection;
    resolve(new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }), { headers: { "Content-Length": String(3 * 1024 * 1024) } }));
    expect(await preview).toBeUndefined(); expect(cancel).toHaveBeenCalledOnce();
  });
  it("retries Play with its own budget if it joins after a preview's cap decision", async () => {
    contextFixture(); vi.stubGlobal("Blob", ReadableBlob); const loader = createAudioLoader();
    const signal = new AbortController().signal; let play!: ReturnType<typeof loader.loadAudio>;
    const cancel = vi.fn(() => { play = loader.loadAudio("late-play", undefined, "audio/ogg", signal); });
    const fetch = vi.fn().mockResolvedValueOnce(new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }), { headers: { "Content-Length": String(3 * 1024 * 1024) } }))
      .mockImplementation(async () => new Response(new Uint8Array(3 * 1024 * 1024)));
    vi.stubGlobal("fetch", fetch);
    expect(await loader.prepareWaveform("late-play", undefined, "audio/ogg", signal)).toBeUndefined();
    expect((await play).blob.size).toBe(3 * 1024 * 1024); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("requests 3000Hz offline decoding and skips an ignored fallback sample rate", async () => {
    const context = contextFixture(); const construct = vi.fn();
    vi.stubGlobal("OfflineAudioContext", class {
      sampleRate = 3000; decodeAudioData = context.decodeAudioData;
      constructor(...args: number[]) { construct(...args); }
    });
    const loader = createAudioLoader(); const signal = new AbortController().signal;
    expect((await loader.loadAudio("offline-rate", blob(), "audio/ogg", signal)).waveform?.duration).toBe(7);
    expect(construct).toHaveBeenCalledExactlyOnceWith(1, 1, 3000);
    expect(context.close).not.toHaveBeenCalled();
    vi.stubGlobal("OfflineAudioContext", undefined);
    vi.stubGlobal("AudioContext", class { sampleRate = 48000; close = context.close; decodeAudioData = context.decodeAudioData; });
    expect((await loader.loadAudio("ignored-rate", blob(), "audio/ogg", signal)).waveform).toBeUndefined();
    expect(context.decodeAudioData).toHaveBeenCalledOnce(); expect(context.close).toHaveBeenCalledOnce();
  });
  it("shares one live remote fetch and decode between preview and Play", async () => {
    const context = contextFixture(); const loader = createAudioLoader(); vi.stubGlobal("Blob", ReadableBlob);
    const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))); vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    const [preview, playback] = await Promise.all([
      loader.prepareWaveform("shared", undefined, "audio/webm", signal),
      loader.loadAudio("shared", undefined, "audio/webm", signal),
    ]);
    expect(fetch).toHaveBeenCalledOnce(); expect(context.decodeAudioData).toHaveBeenCalledOnce();
    expect(preview).toBe(playback.waveform); expect(playback.blob.size).toBe(3);
    // Settled blobs are not cached: a later Play fetches again but reuses peaks.
    await loader.loadAudio("shared", undefined, "audio/webm", signal);
    expect(fetch).toHaveBeenCalledTimes(2); expect(context.decodeAudioData).toHaveBeenCalledOnce();
  });
  it.each(["preview", "playback"] as const)("detaches aborted %s without cancelling the remaining caller", async cancelled => {
    const context = contextFixture(); const loader = createAudioLoader(); vi.stubGlobal("Blob", ReadableBlob);
    let resolve!: (value: Response) => void;
    const fetch = vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>(done => { resolve = done; })); vi.stubGlobal("fetch", fetch);
    const previewOwner = new AbortController(); const playbackOwner = new AbortController();
    const preview = loader.prepareWaveform("shared-abort", undefined, "audio/webm", previewOwner.signal);
    const playback = loader.loadAudio("shared-abort", undefined, "audio/webm", playbackOwner.signal);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const rejection = expect(cancelled === "preview" ? preview : playback).rejects.toMatchObject({ name: "AbortError" });
    (cancelled === "preview" ? previewOwner : playbackOwner).abort(); await rejection;
    expect(fetch.mock.calls[0]![1]!.signal!.aborted).toBe(false);
    resolve(new Response(new Uint8Array([1, 2, 3])));
    const remaining = await (cancelled === "preview" ? playback : preview);
    expect(remaining).toBeDefined(); expect(context.decodeAudioData).toHaveBeenCalledOnce();
  });
  it("keeps an already-running shared decoder alive for the surviving Play caller", async () => {
    const context = contextFixture(); const loader = createAudioLoader();
    let resolve!: (value: Awaited<ReturnType<typeof context.decodeAudioData>>) => void;
    context.decodeAudioData.mockImplementation(() => new Promise(done => { resolve = done; }));
    const owner = new AbortController();
    const preview = loader.prepareWaveform("decode-abort", blob(), "audio/webm", owner.signal);
    const playback = loader.loadAudio("decode-abort", blob(), "audio/webm", new AbortController().signal);
    await vi.waitFor(() => expect(context.decodeAudioData).toHaveBeenCalledOnce());
    const rejected = expect(preview).rejects.toMatchObject({ name: "AbortError" }); owner.abort(); await rejected;
    expect(context.close).not.toHaveBeenCalled();
    resolve({ duration: 7, numberOfChannels: 1, getChannelData: () => new Float32Array([0.5]) });
    expect((await playback).waveform?.duration).toBe(7); expect(context.close).toHaveBeenCalledOnce();
  });
  it("cancels shared work when its last caller leaves and allows a fresh attempt", async () => {
    contextFixture(); const loader = createAudioLoader(); vi.stubGlobal("Blob", ReadableBlob); let resolve!: (value: Response) => void;
    const fetch = vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>(done => { resolve = done; })); vi.stubGlobal("fetch", fetch);
    const owners = [new AbortController(), new AbortController()];
    const work = owners.map(owner => loader.prepareWaveform("all-abort", undefined, "audio/webm", owner.signal).catch(error => error));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    owners.forEach(owner => owner.abort()); await Promise.all(work);
    expect(fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    resolve(new Response(new Uint8Array([1])));
    fetch.mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    expect((await loader.prepareWaveform("all-abort", undefined, "audio/webm", new AbortController().signal))?.duration).toBe(7);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("serializes previews and cancels queued work without fetching", async () => {
    const context = contextFixture(); vi.stubGlobal("Blob", ReadableBlob); const prepareQueue = createAudioLoader(); const pending: ((value: Response) => void)[] = [];
    const fetch = vi.fn(() => new Promise<Response>(resolve => pending.push(resolve))); vi.stubGlobal("fetch", fetch);
    const controllers = Array.from({ length: 3 }, () => new AbortController());
    const loads = controllers.map((controller, i) => prepareQueue.prepareWaveform(`queue-${i}`, undefined, "audio/webm", controller.signal).catch(() => undefined));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    controllers[2]!.abort();
    pending[0]!(new Response(new Uint8Array([1, 2, 3])));
    await loads[0]; await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    pending[1]!(new Response(new Uint8Array([1, 2, 3])));
    const results = await Promise.all(loads); expect(fetch).toHaveBeenCalledTimes(2);
    expect(context.decodeAudioData).toHaveBeenCalledTimes(2);
    expect(results.slice(0, 2).every(result => result?.duration === 7)).toBe(true);
  });
  it("retains the single native decoder lease after timeout until it really settles", async () => {
    vi.useFakeTimers(); const context = contextFixture();
    type Decoded = Awaited<ReturnType<typeof context.decodeAudioData>>;
    const pending: ((value: Decoded) => void)[] = [];
    context.decodeAudioData.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
    const loads = ["timeout-a", "timeout-b"].map(id => loadAudio(id, blob(), "audio/webm", new AbortController().signal));
    await vi.advanceTimersByTimeAsync(8001);
    expect((await Promise.all(loads)).every(result => result.waveform === undefined)).toBe(true);
    expect(context.close).toHaveBeenCalledTimes(1);
    await loadAudio("timeout-c", blob(), "audio/webm", new AbortController().signal);
    expect(context.decodeAudioData).toHaveBeenCalledTimes(1);
    pending.forEach(resolve => resolve({ duration: 1, numberOfChannels: 1, getChannelData: () => new Float32Array([0.2]) }));
    await vi.advanceTimersByTimeAsync(0);
    context.decodeAudioData.mockResolvedValue({ duration: 1, numberOfChannels: 1, getChannelData: () => new Float32Array([0.2]) });
    const retried = await loadAudio("timeout-c", blob(), "audio/webm", new AbortController().signal);
    expect(retried.waveform?.duration).toBe(1); expect(context.decodeAudioData).toHaveBeenCalledTimes(2);
  });
  it("bounds the compact peak cache and enforces the existing byte cap", async () => {
    contextFixture();
    const signal = new AbortController().signal;
    for (let i = 0; i < 34; i++) await loadAudio(`lru-${i}`, blob(), "audio/webm", signal);
    expect(cachedWaveform("lru-0")).toBeUndefined(); expect(cachedWaveform("lru-33")?.duration).toBe(7);
    await expect(loadAudio("large", { size: 10 * 1024 * 1024 + 1 } as File, "audio/webm", signal)).rejects.toThrow("Download");
  });
  it("silently falls back on decode failure, with a closed context", async () => {
    const context = contextFixture(); context.decodeAudioData.mockRejectedValueOnce(Error("codec"));
    const result = await loadAudio("unsupported-test", blob(), "audio/ogg", new AbortController().signal);
    expect(result.waveform).toBeUndefined(); expect(result.blob.size).toBe(3); expect(context.close).toHaveBeenCalledTimes(1);
  });
});

describe("presentation-only transcript captions", () => {
  const attachments = [{ id: "a", name: "recording.webm", contentType: "audio/webm" }, { id: "b", name: "recording.webm", contentType: "audio/webm" }];
  it("extracts an exact numbered suffix in attachment order without mutating stored text", () => {
    const text = 'Keep the herbs.\n\nAudio transcript 1 ("recording.webm"):\nAdd basil.\n\nAudio transcript 2 ("recording.webm"):\nAdd mint.';
    const message = Object.freeze({ text }); const result = presentTranscripts(message.text, attachments);
    expect(result.text).toBe("Keep the herbs."); expect([...result.captions]).toEqual([["a", "Add basil."], ["b", "Add mint."]]); expect(message.text).toBe(text);
  });
  it.each(['Audio transcript 2 ("recording.webm"):\nHello', 'Audio transcript 1 ("other.webm"):\nHello', 'Audio transcript 1 ("recording.webm"):\n Hello', 'Audio transcript 1 ("recording.webm"):\n', 'I typed Audio transcript 1 ("recording.webm"):\nHello', 'Audio transcript 01 ("recording.webm"):\nHello'])('leaves noncanonical or user-authored prose unchanged: %s', text => {
    expect(presentTranscripts(text, attachments)).toEqual({ text, captions: new Map() });
  });
  it("does not guess when duplicate names have only one transcript", () => {
    const text = 'Audio transcript 1 ("recording.webm"):\nHello';
    expect(presentTranscripts(text, attachments)).toEqual({ text, captions: new Map() });
  });
  it("requires a matching audio attachment on this message", () => {
    const text = 'Audio transcript 1 ("recording.webm"):\nHello';
    expect(presentTranscripts(text, [])).toEqual({ text, captions: new Map() });
    expect(presentTranscripts(text, [{ ...attachments[0]!, contentType: "text/plain" }]).text).toBe(text);
  });
});
