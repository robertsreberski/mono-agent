import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { FixtureMediaRecorder, installVoiceFixture } from "../test/voice-fixtures";
import { chooseRecordingType, VoiceRecorder, VOICE_MAX_BYTES } from "../voice-recorder";
import { VoiceComposer, VoiceMessagePanel } from "./VoiceComposer";
vi.mock("../api", () => ({ api: { transcribe: vi.fn() } }));
let fixture: ReturnType<typeof installVoiceFixture>;
beforeEach(() => { fixture = installVoiceFixture(); vi.mocked(api.transcribe).mockReset().mockResolvedValue({ text: "A fictional request." }); });
afterEach(() => { fixture.restore(); vi.useRealTimers(); });
function session() { return { isCurrent: vi.fn(() => true), prepare: vi.fn(async () => "thread-one"), submit: vi.fn(async (_text: string) => undefined) }; }
async function record() {
  fireEvent.click(screen.getByRole("button", { name: "Record voice message" }));
  await screen.findByRole("button", { name: "Stop recording" });
  fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
  await screen.findByRole("button", { name: "Send voice message" });
}

describe("voice composer", () => {
  it("keeps the elapsed timer out of phase announcements", () => {
    const view = render(<VoiceMessagePanel phase="recording" seconds={17} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/^Recording$/);
    expect(screen.getByRole("timer")).toHaveAttribute("aria-live", "off");
    view.rerender(<VoiceMessagePanel phase="recording" seconds={18} />);
    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveTextContent(/^Recording$/);
    expect(screen.getByRole("timer")).toHaveTextContent("0:18 / 2:00");
  });
  it("captures only on click and Send transcribes then submits exactly once", async () => {
    const owner = session();
    render(<VoiceComposer selectionGeneration={0} captureSubmission={() => owner} />);
    expect(fixture.getUserMedia).not.toHaveBeenCalled();
    await record();
    const send = screen.getByRole("button", { name: "Send voice message" });
    fireEvent.click(send); fireEvent.click(send);
    await waitFor(() => expect(owner.submit).toHaveBeenCalledWith("A fictional request."));
    expect(owner.submit).toHaveBeenCalledTimes(1);
    expect(api.transcribe).toHaveBeenCalledTimes(1);
    expect(fixture.stop).toHaveBeenCalledTimes(2);
  });
  it("keeps the transcript for ambiguous submission retries", async () => {
    const owner = session();
    owner.submit.mockRejectedValueOnce(new Error("Acknowledgement unavailable"));
    render(<VoiceComposer selectionGeneration={0} captureSubmission={() => owner} />);
    await record(); fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry submission" }));
    await waitFor(() => expect(owner.submit).toHaveBeenCalledTimes(2));
    expect(api.transcribe).toHaveBeenCalledTimes(1);
    expect(owner.submit.mock.calls[0]).toEqual(owner.submit.mock.calls[1]);
  });
  it("shows permission denial without submitting", async () => {
    fixture.getUserMedia.mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
    const owner = session();
    render(<VoiceComposer selectionGeneration={0} captureSubmission={() => owner} />);
    fireEvent.click(screen.getByRole("button", { name: "Record voice message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Microphone permission denied");
    expect(owner.submit).not.toHaveBeenCalled();
  });
  it("cancels late permission and stops every track", async () => {
    let resolve!: (stream: MediaStream) => void;
    fixture.getUserMedia.mockImplementation(() => new Promise((done) => { resolve = done; }));
    render(<VoiceComposer selectionGeneration={0} captureSubmission={session} />);
    fireEvent.click(screen.getByRole("button", { name: "Record voice message" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel voice message" }));
    await act(async () => resolve(fixture.stream));
    expect(fixture.stop).toHaveBeenCalledTimes(2);
    expect(FixtureMediaRecorder.instances).toHaveLength(0);
  });
  it("fences A → B → A and late transcription after cancellation", async () => {
    let resolve!: (value: { text: string }) => void;
    vi.mocked(api.transcribe).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const owner = session();
    const view = render(<VoiceComposer selectionGeneration={0} captureSubmission={() => owner} />);
    await record(); fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    await waitFor(() => expect(api.transcribe).toHaveBeenCalled());
    owner.isCurrent.mockReturnValue(false);
    view.rerender(<VoiceComposer selectionGeneration={2} captureSubmission={() => owner} />);
    await act(async () => resolve({ text: "Stale text" }));
    expect(owner.submit).not.toHaveBeenCalled();
    expect((vi.mocked(api.transcribe).mock.calls[0]![2]).aborted).toBe(true);
  });
  it("aborts cancellation before dispatch and never reports it as withdrawal after dispatch", async () => {
    let resolve!: (value: { text: string }) => void;
    vi.mocked(api.transcribe).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const owner = session();
    render(<VoiceComposer selectionGeneration={0} captureSubmission={() => owner} />);
    await record(); fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    await waitFor(() => expect(api.transcribe).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Cancel voice message" }));
    await act(async () => resolve({ text: "Cancelled text" }));
    expect(owner.submit).not.toHaveBeenCalled();
  });
  it.each(["resolve", "reject"] as const)("cleans up same-operation ownership loss on prepare %s without a selection rerender", async (outcome) => {
    let resolve!: (value: string) => void;
    let reject!: (error: Error) => void;
    const owner = session();
    owner.prepare.mockImplementation(() => new Promise((done, fail) => { resolve = done; reject = fail; }));
    render(<VoiceComposer selectionGeneration={0} captureSubmission={() => owner} />);
    await record(); fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    expect(owner.prepare).toHaveBeenCalledWith(expect.any(AbortSignal));
    owner.isCurrent.mockReturnValue(false);
    await act(async () => { if (outcome === "resolve") resolve("thread-one"); else reject(new Error("Synthetic refusal")); });
    expect(screen.getByRole("button", { name: "Record voice message" })).toHaveAttribute("aria-disabled", "false");
    expect(api.transcribe).not.toHaveBeenCalled(); expect(owner.submit).not.toHaveBeenCalled();
    expect(fixture.stop).toHaveBeenCalledTimes(2);
  });
  it.each(["resolve", "reject"] as const)("does not cancel a newer recording when old prepare %ss", async (outcome) => {
    let resolve!: (value: string) => void;
    let reject!: (error: Error) => void;
    const oldOwner = session(); const nextOwner = session();
    oldOwner.prepare.mockImplementation(() => new Promise((done, fail) => { resolve = done; reject = fail; }));
    const capture = vi.fn().mockReturnValueOnce(oldOwner).mockReturnValue(nextOwner);
    render(<VoiceComposer selectionGeneration={0} captureSubmission={capture} />);
    await record(); fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel voice message" }));
    fireEvent.click(screen.getByRole("button", { name: "Record voice message" }));
    await screen.findByRole("button", { name: "Stop recording" });
    await act(async () => { if (outcome === "resolve") resolve("thread-one"); else reject(new Error("Synthetic refusal")); });
    expect(screen.getByRole("button", { name: "Stop recording" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    fireEvent.click(await screen.findByRole("button", { name: "Send voice message" }));
    await waitFor(() => expect(nextOwner.submit).toHaveBeenCalledTimes(1));
    expect(oldOwner.submit).not.toHaveBeenCalled(); expect(api.transcribe).toHaveBeenCalledTimes(1);
    expect(fixture.stop).toHaveBeenCalledTimes(4);
  });
  it("provider failure produces no submission and preserves a retryable recording", async () => {
    vi.mocked(api.transcribe).mockRejectedValueOnce(new Error("Service cannot decode this format"));
    const owner = session();
    render(<VoiceComposer selectionGeneration={0} captureSubmission={() => owner} />);
    await record(); fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("cannot decode");
    expect(owner.submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    await waitFor(() => expect(owner.submit).toHaveBeenCalledTimes(1));
  });
  it("does not capture over a text/attachment/quote draft or an older-server capability", () => {
    render(<VoiceComposer unavailableReason="Send or clear text, files and quotes before recording." selectionGeneration={0} captureSubmission={session} />);
    expect(screen.getByRole("button", { name: "Record voice message" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Record voice message" }));
    expect(screen.getByText("Send or clear text, files and quotes before recording.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Record voice message" })).toHaveAccessibleDescription("Send or clear text, files and quotes before recording.");
    fireEvent.keyDown(screen.getByRole("button", { name: "Record voice message" }), { key: "Escape" });
    expect(screen.getByText("Send or clear text, files and quotes before recording.")).toHaveClass("sr-only");
    expect(fixture.getUserMedia).not.toHaveBeenCalled();
  });
  it("pagehide discards capture and resets controls for a restored page", async () => {
    const owner = session();
    render(<VoiceComposer selectionGeneration={0} captureSubmission={() => owner} />);
    fireEvent.click(screen.getByRole("button", { name: "Record voice message" }));
    await screen.findByRole("button", { name: "Stop recording" });
    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(screen.getByRole("button", { name: "Record voice message" })).toHaveAttribute("aria-disabled", "false");
    expect(fixture.stop).toHaveBeenCalledTimes(2);
    expect(owner.submit).not.toHaveBeenCalled();
  });
  it("cleans up capture and late callbacks on unmount", async () => {
    const owner = session();
    const view = render(<VoiceComposer selectionGeneration={0} captureSubmission={() => owner} />);
    fireEvent.click(screen.getByRole("button", { name: "Record voice message" }));
    await screen.findByRole("button", { name: "Stop recording" });
    const recorder = FixtureMediaRecorder.instances[0]!;
    view.unmount();
    expect(fixture.stop).toHaveBeenCalledTimes(2);
    expect(recorder.onstop).toBeNull();
    expect(recorder.ondataavailable).toBeNull();
    expect(owner.submit).not.toHaveBeenCalled();
  });
});

describe("recording bounds and formats", () => {
  it("negotiates MP4 on Safari and Ogg without assuming WebM", () => {
    FixtureMediaRecorder.supported = ["audio/mp4"];
    expect(chooseRecordingType(FixtureMediaRecorder)).toBe("audio/mp4");
    FixtureMediaRecorder.supported = ["audio/ogg;codecs=opus"];
    expect(chooseRecordingType(FixtureMediaRecorder)).toBe("audio/ogg;codecs=opus");
    FixtureMediaRecorder.supported = [];
    expect(chooseRecordingType(FixtureMediaRecorder)).toBeUndefined();
  });
  it("uses the actual recorder container, caps duration, and releases tracks/timers", async () => {
    vi.useFakeTimers();
    const ready = vi.fn();
    const capture = new VoiceRecorder({ ready, recording: vi.fn(), elapsed: vi.fn(), error: vi.fn() });
    await capture.start();
    FixtureMediaRecorder.instances[0]!.mimeType = "audio/mp4";
    await vi.advanceTimersByTimeAsync(120_000);
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
    expect(error).toHaveBeenCalledWith(expect.stringContaining("10 MiB"));
    expect(ready).not.toHaveBeenCalled();
    expect(fixture.stop).toHaveBeenCalledTimes(2);
  });
});
