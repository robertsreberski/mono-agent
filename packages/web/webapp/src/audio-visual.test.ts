import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioMeter, rmsAmplitude } from "./audio-meter";
import { cachedWaveform, createAudioLoader, extractPeaks, loadAudio } from "./audio-waveform";
import { VoiceRecorder } from "./voice-recorder";
import { FixtureMediaRecorder, installVoiceFixture } from "./test/voice-fixtures";
import { presentTranscripts } from "./voice-transcripts";

function contextFixture() {
  const close = vi.fn(async () => {}); const disconnect = vi.fn(); const resume = vi.fn(async () => {});
  const decodeAudioData = vi.fn(async () => ({ duration: 7, numberOfChannels: 1, getChannelData: () => new Float32Array([0, 0.5, -1, 0.2]) }));
  vi.stubGlobal("AudioContext", class {
    state = "suspended"; close = close; resume = resume; decodeAudioData = decodeAudioData;
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
  it("limits concurrency to two and cancels queued work without fetching", async () => {
    contextFixture(); const prepareQueue = createAudioLoader(); const pending: ((value: Response) => void)[] = [];
    const fetch = vi.fn(() => new Promise<Response>(resolve => pending.push(resolve))); vi.stubGlobal("fetch", fetch);
    const controllers = Array.from({ length: 3 }, () => new AbortController());
    const loads = controllers.map((controller, i) => prepareQueue.prepareWaveform(`queue-${i}`, undefined, "audio/webm", controller.signal).catch(() => undefined));
    await Promise.resolve(); await Promise.resolve(); expect(fetch).toHaveBeenCalledTimes(2);
    controllers[2]!.abort();
    for (const resolve of pending) resolve(new Response(new Uint8Array([1, 2, 3])));
    await Promise.all(loads); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("times out without allowing orphaned native decodes to exceed two", async () => {
    vi.useFakeTimers(); const context = contextFixture();
    type Decoded = Awaited<ReturnType<typeof context.decodeAudioData>>;
    const pending: ((value: Decoded) => void)[] = [];
    context.decodeAudioData.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
    const loads = ["timeout-a", "timeout-b"].map(id => loadAudio(id, blob(), "audio/webm", new AbortController().signal));
    await vi.advanceTimersByTimeAsync(8001);
    expect((await Promise.all(loads)).every(result => result.waveform === undefined)).toBe(true);
    expect(context.close).toHaveBeenCalledTimes(2);
    await loadAudio("timeout-c", blob(), "audio/webm", new AbortController().signal);
    expect(context.decodeAudioData).toHaveBeenCalledTimes(2);
    pending.forEach(resolve => resolve({ duration: 1, numberOfChannels: 1, getChannelData: () => new Float32Array([0.2]) }));
    await vi.advanceTimersByTimeAsync(0);
    context.decodeAudioData.mockResolvedValue({ duration: 1, numberOfChannels: 1, getChannelData: () => new Float32Array([0.2]) });
    const retried = await loadAudio("timeout-c", blob(), "audio/webm", new AbortController().signal);
    expect(retried.waveform?.duration).toBe(1); expect(context.decodeAudioData).toHaveBeenCalledTimes(3);
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
