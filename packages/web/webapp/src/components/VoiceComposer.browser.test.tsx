import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { commands, page, userEvent } from "@vitest/browser/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { installVoiceFixture } from "../test/voice-fixtures";
import { VoiceComposer } from "./VoiceComposer";
import "../styles.css";
vi.mock("../api", () => ({ api: { transcribe: vi.fn() } }));
declare module "@vitest/browser/context" { interface BrowserCommands { saveVoiceFixture(bytes: number[]): Promise<void> } }
const engine = /Chrome\//u.test(navigator.userAgent) ? "chromium" : "webkit";
const shots = import.meta.env.VITE_VOICE_SHOTS as string | undefined;
let fixture: ReturnType<typeof installVoiceFixture>;
beforeEach(() => { fixture = installVoiceFixture(); vi.mocked(api.transcribe).mockReset().mockResolvedValue({ text: "A synthetic request." }); });
afterEach(() => fixture.restore());
const shot = async (name: string) => { if (shots) await page.screenshot({ path: `${shots}/${engine}-${name}.png` }); };
function setup(unavailableReason?: string) {
  const owner = { isCurrent: vi.fn(() => true), prepare: vi.fn(async () => "fixture-thread"), submit: vi.fn(async () => undefined) };
  const view = render(<main style={{ maxWidth: 620, margin: "24px auto", padding: 12 }}><h1>Synthetic voice-message fixture</h1>{import.meta.env.VITE_VOICE_REVISION && <p style={{ fontSize: 10 }}>Fixture revision: {import.meta.env.VITE_VOICE_REVISION}</p>}<VoiceComposer unavailableReason={unavailableReason} selectionGeneration={0} captureSubmission={() => owner} /></main>);
  return { owner, ...view };
}
async function record() {
  await userEvent.click(screen.getByRole("button", { name: "Record voice message" }));
  await screen.findByRole("button", { name: "Stop recording" });
}
async function stop() {
  await userEvent.click(screen.getByRole("button", { name: "Stop recording" }));
  await screen.findByRole("button", { name: "Send voice message" });
}

describe("automated synthetic voice states", () => {
  for (const [name, width, height] of [["desktop", 1280, 900], ["mobile", 390, 844]] as const) {
    it.runIf(engine === "chromium" || name === "mobile")(`${name}: keyboard record/stop/send, progress, actionable failure, cancellation`, async () => {
      await page.viewport(width, height);
      let resolve!: (value: { text: string }) => void;
      vi.mocked(api.transcribe).mockImplementation(() => new Promise((done) => { resolve = done; }));
      const { owner, container } = setup();
      const recordButton = screen.getByRole("button", { name: "Record voice message" });
      recordButton.focus();
      await userEvent.keyboard("{Enter}");
      await screen.findByRole("button", { name: "Stop recording" });
      await shot(`synthetic-${name}-recording`);
      await stop();
      await shot(`synthetic-${name}-ready`);
      for (const button of container.querySelectorAll("button")) {
        expect(button.scrollHeight).toBeLessThanOrEqual(button.clientHeight + 1);
        expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth + 1);
      }
      const send = screen.getByRole("button", { name: "Send voice message" });
      fireEvent.click(send); fireEvent.click(send);
      await waitFor(() => expect(api.transcribe).toHaveBeenCalledTimes(1));
      await screen.findByText("Transcribing…");
      await shot(`synthetic-${name}-transcribing`);
      for (const button of container.querySelectorAll("button")) expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      await userEvent.click(screen.getByRole("button", { name: "Cancel voice message" }));
      await act(async () => resolve({ text: "Cancelled fixture request." }));
      expect(owner.submit).not.toHaveBeenCalled();
      vi.mocked(api.transcribe).mockRejectedValueOnce(new Error("Transcription failed. Check that the local service supports this recording format, then retry Send."));
      await record(); await stop();
      await userEvent.click(screen.getByRole("button", { name: "Send voice message" }));
      await screen.findByRole("alert");
      await shot(`synthetic-${name}-provider-failure`);
      expect(owner.submit).not.toHaveBeenCalled();
    });
    it.runIf(engine === "chromium" || name === "mobile")(`${name}: permission denial and disabled secure-context explanation`, async () => {
      await page.viewport(width, height);
      fixture.getUserMedia.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
      setup();
      await userEvent.click(screen.getByRole("button", { name: "Record voice message" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Microphone permission denied");
      await shot(`synthetic-${name}-permission-denied`);
      vi.stubGlobal("isSecureContext", false);
      // Re-evaluate via unmount/remount rather than claim a real insecure browser visit.
      const { cleanup } = await import("@testing-library/react");
      cleanup(); setup();
      expect(screen.getByRole("button", { name: "Record voice message" })).toBeDisabled();
      expect(screen.getByText(/Microphone access needs HTTPS/)).toBeVisible();
      await shot(`synthetic-${name}-insecure`);
    });
  }
  it("draft gate preserves text/files/quotes without asking permission", async () => {
    setup("Send or clear text, files and quotes before recording a voice message.");
    expect(screen.getByRole("button", { name: "Record voice message" })).toBeDisabled();
    expect(fixture.getUserMedia).not.toHaveBeenCalled();
  });
  it.runIf(/Chrome\//u.test(navigator.userAgent))("real Chromium MediaRecorder records synthetic browser microphone input through the component", async () => {
    fixture.restore();
    // Playwright launches Chromium with fake-device/fake-permission flags. No physical microphone is opened.
    const { owner } = setup();
    await record();
    await new Promise((resolve) => setTimeout(resolve, 650));
    await stop();
    await userEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    await waitFor(() => expect(owner.submit).toHaveBeenCalledTimes(1));
    const audio = vi.mocked(api.transcribe).mock.calls[0]![1];
    expect(audio.size).toBeGreaterThan(100);
    expect(audio.type).toMatch(/^audio\/(webm|mp4|ogg)/u);
    const prefix = new Uint8Array(await audio.slice(0, 4).arrayBuffer());
    expect([...prefix]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    await commands.saveVoiceFixture([...new Uint8Array(await audio.arrayBuffer())]);
  });
});
