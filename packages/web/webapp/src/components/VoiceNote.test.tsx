import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VoiceNote } from "./VoiceNote";
import { loadAudio, prepareWaveform } from "../audio-waveform";
vi.mock("../audio-waveform", () => ({ cachedWaveform: () => undefined, loadAudio: vi.fn(), prepareWaveform: vi.fn() }));
beforeEach(() => {
  vi.mocked(prepareWaveform).mockReset().mockResolvedValue({ peaks: Array(48).fill(0.5), duration: 7 });
  vi.mocked(loadAudio).mockReset().mockResolvedValue({ blob: new Blob(["audio"]), waveform: { peaks: Array(48).fill(0.5), duration: 7 } });
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:voice-test"), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async function (this: HTMLMediaElement) { this.dispatchEvent(new Event("play")); });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) { this.dispatchEvent(new Event("pause")); });
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("is lazy, plays/pauses, seeks with keyboard and pointer, and derives finite duration", async () => {
  const view = render(<VoiceNote id="a" name="recording.webm" recorded contentType="audio/webm" />);
  expect(loadAudio).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Play voice note, duration unknown" }));
  await screen.findByRole("button", { name: "Pause voice note, 0:07" });
  const slider = screen.getByRole("slider");
  fireEvent.keyDown(slider, { key: "ArrowRight" }); expect(slider).toHaveAttribute("aria-valuenow", "5");
  expect(screen.getByText("0:05 / 0:07")).toBeVisible();
  fireEvent.keyDown(slider, { key: "End" }); expect(slider).toHaveAttribute("aria-valuenow", "7");
  fireEvent.keyDown(slider, { key: "Home" }); expect(slider).toHaveAttribute("aria-valuenow", "0");
  vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ left: 0, width: 100 } as DOMRect);
  slider.setPointerCapture = vi.fn(); slider.hasPointerCapture = () => true; slider.releasePointerCapture = vi.fn();
  fireEvent.pointerDown(slider, { clientX: 50, pointerId: 1 });
  expect(slider).toHaveAttribute("aria-valuenow", "3.5");
  fireEvent.click(screen.getByRole("button", { name: "Pause voice note, 0:07" }));
  expect(screen.getByRole("button", { name: "Play voice note, 0:07" })).toBeVisible();
  view.unmount(); expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:voice-test");
});
it("aborts pending work on unmount and leaves a neutral waveform on decode failure", async () => {
  let resolve!: (value: Awaited<ReturnType<typeof loadAudio>>) => void;
  vi.mocked(loadAudio).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const view = render(<VoiceNote id="b" name="ambient.ogg" contentType="audio/ogg" />);
  fireEvent.click(screen.getByRole("button"));
  const signal = vi.mocked(loadAudio).mock.calls[0]![3]; view.unmount(); expect(signal.aborted).toBe(true);
  await act(async () => resolve({ blob: new Blob(["audio"]) })); expect(URL.createObjectURL).not.toHaveBeenCalled();
  vi.mocked(loadAudio).mockResolvedValueOnce({ blob: new Blob(["audio"]) });
  render(<VoiceNote id="c" name="ambient.ogg" contentType="audio/ogg" />); fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalled());
  expect(screen.getByRole("slider")).toHaveAttribute("aria-disabled", "true");
  expect(screen.queryByRole("status")).toBeNull();
  expect([...screen.getByRole("slider").querySelectorAll<HTMLElement>("i")].every(bar => bar.style.height === "3px")).toBe(true);
});
it("keeps upload progress, failure/retry and filename accessibility", () => {
  const retry = vi.fn(); const view = render(<VoiceNote id="a" name="recording.webm" recorded contentType="audio/webm" uploading={45} />);
  expect(screen.getByRole("progressbar")).toHaveValue(45); expect(screen.getByRole("button")).toBeDisabled();
  expect(screen.getByRole("progressbar").closest('[role="status"]')).toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent(/^Uploading recording.webm$/);
  view.rerender(<VoiceNote id="a" name="recording.webm" recorded contentType="audio/webm" uploading={65} />);
  expect(screen.getByRole("progressbar")).toHaveValue(65);
  expect(screen.getByRole("status")).toHaveTextContent(/^Uploading recording.webm$/);
  view.rerender(<VoiceNote id="a" name="recording.webm" recorded contentType="audio/webm" failed onRetry={retry} />);
  expect(screen.getByLabelText("Audio attachment: recording.webm")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Retry upload" })); expect(retry).toHaveBeenCalledTimes(1);
});

it("decodes a local file eagerly, but plays synchronously within the first click", async () => {
  vi.mocked(prepareWaveform).mockImplementationOnce(() => new Promise(() => {}));
  const file = new File(["audio"], "recording.webm", { type: "audio/webm" });
  render(<VoiceNote id="local-sync" name={file.name} file={file} recorded contentType={file.type} />);
  expect(prepareWaveform).toHaveBeenCalledWith("local-sync", file, file.type, expect.any(AbortSignal));
  expect(loadAudio).not.toHaveBeenCalled(); expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button"));
  expect(URL.createObjectURL).toHaveBeenCalledWith(file);
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  expect(loadAudio).not.toHaveBeenCalled();
});
it("shows remote audio ready for another gesture if async play is rejected", async () => {
  vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new DOMException("Gesture required", "NotAllowedError"));
  render(<VoiceNote id="gesture" name="garden.ogg" contentType="audio/ogg" />);
  fireEvent.click(screen.getByRole("button"));
  expect(await screen.findByText("Tap to play")).toBeVisible();
  fireEvent.click(screen.getByRole("button"));
  expect(screen.queryByText("Tap to play")).toBeNull();
  expect(screen.getByRole("button", { name: "Pause garden.ogg, 0:07" })).toBeVisible();
});
it("gates remote preparation on visible dwell, aborts on leave and skips saveData", async () => {
  vi.useFakeTimers();
  let observe!: (entries: { isIntersecting: boolean }[]) => void;
  const disconnect = vi.fn(); const constructed = vi.fn(); const observed = vi.fn();
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: typeof observe) { constructed(); observe = callback; }
    observe = observed; disconnect = disconnect;
  });
  vi.mocked(prepareWaveform).mockImplementation(() => new Promise(() => {}));
  const view = render(<VoiceNote id="visible" name="garden.ogg" contentType="audio/ogg" />);
  expect(prepareWaveform).not.toHaveBeenCalled();
  act(() => observe([{ isIntersecting: true }]));
  await act(async () => vi.advanceTimersByTimeAsync(200));
  expect(prepareWaveform).not.toHaveBeenCalled();
  act(() => observe([{ isIntersecting: false }]));
  await act(async () => vi.advanceTimersByTimeAsync(100));
  expect(prepareWaveform).not.toHaveBeenCalled();
  act(() => observe([{ isIntersecting: true }]));
  await act(async () => vi.advanceTimersByTimeAsync(251));
  expect(prepareWaveform).toHaveBeenCalledTimes(1);
  const signal = vi.mocked(prepareWaveform).mock.calls[0]![3];
  act(() => observe([{ isIntersecting: false }])); expect(signal.aborted).toBe(true);
  view.unmount(); expect(disconnect).toHaveBeenCalledTimes(1);
  constructed.mockClear(); observed.mockClear();
  Object.defineProperty(navigator, "connection", { configurable: true, value: { saveData: true } });
  try {
    render(<VoiceNote id="save-data" name="garden.ogg" contentType="audio/ogg" />);
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(prepareWaveform).toHaveBeenCalledTimes(1); expect(loadAudio).not.toHaveBeenCalled();
    expect(constructed).not.toHaveBeenCalled(); expect(observed).not.toHaveBeenCalled();
  } finally { Reflect.deleteProperty(navigator, "connection"); }
});

it("shows a local waveform and duration before the first Play without creating a URL", async () => {
  const file = new File(["audio"], "recording.webm", { type: "audio/webm" });
  const view = render(<VoiceNote id="local-preview" name={file.name} file={file} recorded contentType={file.type} />);
  expect(await screen.findByRole("button", { name: "Play voice note, 0:07" })).toBeVisible();
  expect([...view.container.querySelectorAll<HTMLElement>(".voice-waveform i")].every(bar => parseFloat(bar.style.height) > 3)).toBe(true);
  expect(URL.createObjectURL).not.toHaveBeenCalled(); expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
});
