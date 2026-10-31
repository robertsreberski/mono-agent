import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FixtureMediaRecorder, installVoiceFixture } from "../test/voice-fixtures";
import { chooseRecordingType, recordingFile, VoiceRecorder, VOICE_MAX_BYTES } from "../voice-recorder";
let fixture: ReturnType<typeof installVoiceFixture>;
beforeEach(() => { fixture = installVoiceFixture(); });
afterEach(() => { fixture.restore(); vi.useRealTimers(); });
describe("recording bounds and formats", () => {
  it("negotiates MP4 on Safari and Ogg without assuming WebM", () => {
    FixtureMediaRecorder.supported = ["audio/mp4"];
    expect(chooseRecordingType(FixtureMediaRecorder)).toBe("audio/mp4");
    FixtureMediaRecorder.supported = ["audio/ogg;codecs=opus"];
    expect(chooseRecordingType(FixtureMediaRecorder)).toBe("audio/ogg;codecs=opus");
    FixtureMediaRecorder.supported = [];
    expect(chooseRecordingType(FixtureMediaRecorder)).toBeUndefined();
  });
  it("records beyond 120 seconds within the byte cap, uses the actual container, and releases tracks/timers", async () => {
    vi.useFakeTimers();
    const ready = vi.fn(); const elapsed = vi.fn();
    const capture = new VoiceRecorder({ ready, recording: vi.fn(), elapsed, error: vi.fn() });
    await capture.start();
    FixtureMediaRecorder.instances[0]!.mimeType = "audio/mp4";
    await vi.advanceTimersByTimeAsync(181_000);
    expect(ready).not.toHaveBeenCalled(); expect(elapsed).toHaveBeenLastCalledWith(181);
    expect(FixtureMediaRecorder.instances[0]!.state).toBe("recording");
    capture.stop();
    await vi.runAllTicks();
    expect(ready).toHaveBeenCalledTimes(1);
    expect((ready.mock.calls[0]![0] as Blob).type).toBe("audio/mp4");
    expect(fixture.stop).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    capture.dispose();
  });
  it("discards over-byte-limit capture rather than sending truncated audio", async () => {
    const error = vi.fn(); const ready = vi.fn();
    const capture = new VoiceRecorder({ ready, recording: vi.fn(), elapsed: vi.fn(), error });
    await capture.start();
    FixtureMediaRecorder.instances[0]!.chunk(new Blob([new Uint8Array(VOICE_MAX_BYTES + 1)]));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("byte limit"));
    expect(ready).not.toHaveBeenCalled();
    expect(fixture.stop).toHaveBeenCalledTimes(2);
  });
});

describe("recording attachments", () => {
  it.each([["audio/webm;codecs=opus", "audio/webm", "recording.webm"], ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "recording.m4a"], ["audio/ogg;codecs=opus", "audio/ogg", "recording.ogg"]])("canonicalizes actual %s without relabelling its container", (mime, type, name) => {
    const file = recordingFile(new Blob(["fixture"], { type: mime }));
    expect(file.type).toBe(type); expect(file.name).toBe(name); expect(file.size).toBe(7);
  });
  it.each(["video/webm", "audio/mp4;codecs=unsafe", "audio/webm;garbage=opus"])("rejects unsupported metadata %s", (type) => {
    expect(() => recordingFile(new Blob(["fixture"], { type }))).toThrow("format");
  });
  it("honors a stricter remaining attachment budget", async () => {
    const error = vi.fn(); const ready = vi.fn();
    const capture = new VoiceRecorder({ ready, recording: vi.fn(), elapsed: vi.fn(), error }, 3);
    await capture.start(); FixtureMediaRecorder.instances[0]!.chunk(new Blob([new Uint8Array(4)]));
    expect(error).toHaveBeenCalledTimes(1); expect(ready).not.toHaveBeenCalled(); expect(fixture.stop).toHaveBeenCalledTimes(2);
  });
  it("cancels late permission without retaining tracks or a recording", async () => {
    let resolve!: (value: MediaStream) => void;
    fixture.getUserMedia.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const ready = vi.fn(); const capture = new VoiceRecorder({ ready, recording: vi.fn(), elapsed: vi.fn(), error: vi.fn() });
    const pending = capture.start(); capture.dispose(); resolve(fixture.stream); await pending;
    expect(ready).not.toHaveBeenCalled(); expect(fixture.stop).toHaveBeenCalledTimes(2); expect(FixtureMediaRecorder.instances).toHaveLength(0);
  });
});
