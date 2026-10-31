import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { commands, page, userEvent } from "@vitest/browser/context";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, uploadContent } from "./api";
import { useAssistantRuntime, type PendingAttachment } from "@assistant-ui/react";
import { ConsoleStoreProvider, SELECTED_AGENT_STORAGE_KEY, useConsoleStore } from "./console-store";
import { readComposerDraft, resetComposerDraft, writeComposerDraft } from "./composer-draft";
import { WebRuntimeProvider } from "./runtime";
import { Chat } from "./components/Chat";
import { agent, attachment, bootstrap, thread, uploadLimits } from "./test/fixtures";
import { useRecordedAudio } from "./recorded-audio-context";
import { FixtureMediaRecorder, installVoiceFixture } from "./test/voice-fixtures";
import { createThreadPersistence } from "./thread-persistence";
import type { ThreadSummary, WebMessage } from "./types";
import "./styles.css";

vi.mock("./api", async (original) => ({
  ...await original<typeof import("./api")>(),
  uploadContent: vi.fn(),
  api: {
    bootstrap: vi.fn(), activeThreads: vi.fn(), thread: vi.fn(), threads: vi.fn(), messages: vi.fn(),
    createThread: vi.fn(), patchThread: vi.fn(), agentSkills: vi.fn(), agentModels: vi.fn(),
    submit: vi.fn(), submission: vi.fn(), transcribe: vi.fn(), cancelTurn: vi.fn(), cronOverview: vi.fn(),
    projects: vi.fn(), projectThreads: vi.fn(), listTags: vi.fn(), createUpload: vi.fn(), deleteUpload: vi.fn(),
  },
}));
vi.mock("./notifications", () => ({ NotificationBell: () => null }));
declare module "@vitest/browser/context" { interface BrowserCommands { saveVoiceFixture(bytes: number[]): Promise<void>; } }
class FixtureEventSource {
  static current: FixtureEventSource;
  constructor() { FixtureEventSource.current = this; }
  readyState = 1; onopen = null; onmessage: ((event: MessageEvent) => void) | null = null; onerror = null;
  addEventListener() {} removeEventListener() {} close() {}
}
const persistence = createThreadPersistence();
let fixture: ReturnType<typeof installVoiceFixture>;
let store: ReturnType<typeof useConsoleStore>;
let runtime: NonNullable<ReturnType<typeof useAssistantRuntime>>;
let uploads: Map<string, import("./types").WebAttachment>;
let nextUpload = 0;
let recorded: NonNullable<ReturnType<typeof useRecordedAudio>>;
function RuntimeProbe() { runtime = useAssistantRuntime()!; recorded = useRecordedAudio()!; return null; }
const created = thread("voice-created", "alpha", { title: "Synthetic voice conversation" });
const other = thread("voice-other", "alpha", { title: "Other synthetic conversation" });
const fixtureAgent = agent("alpha", {
  models: ["provider/model", "provider/other"], defaultEffort: "medium",
  modelOptions: {
    "provider/model": { reasoning: true, effortLevels: ["low", "medium", "high"], supportsContext1M: true, context1M: true },
    "provider/other": { reasoning: true, effortLevels: ["low", "high"], supportsContext1M: true },
  },
  runSettings: { config: { model: "provider/model", effort: "medium" }, override: null,
    effective: { model: "provider/model", effort: "medium", modelSource: "config", effortSource: "config" } },
});
function Probe() {
  const current = useConsoleStore();
  useLayoutEffect(() => { store = current; });
  useLayoutEffect(() => { current.setConversationVisible(true); return () => current.setConversationVisible(false); }, [current.setConversationVisible]);
  return null;
}
function mount() {
  return render(<ConsoleStoreProvider><Probe /><WebRuntimeProvider>
    <RuntimeProbe /><div className="voice-console-fixture" style={{ height: "100dvh", display: "flex", flexDirection: "column", maxWidth: 1000, margin: "auto" }}>
      <Chat onBack={() => store.setConversationVisible(false)} />
    </div>
  </WebRuntimeProvider></ConsoleStoreProvider>);
}
function seed(selected?: ThreadSummary) {
  vi.mocked(api.bootstrap).mockResolvedValue({ ...bootstrap([fixtureAgent], selected ? [selected, other] : [], selected?.id), limits: { ...uploadLimits, maxFileBytes: 20 * 1024 * 1024, maxTurnBytes: 64 * 1024 * 1024, accept: ["text/plain", "audio/webm", "audio/mp4", "audio/ogg"] }, voice: { enabled: true, maxBytes: 10485760, maxTextCharacters: 8000 } });
  vi.mocked(api.threads).mockResolvedValue({ threads: selected ? [selected, other] : [] });
  vi.mocked(api.thread).mockImplementation(async (id) => ({ thread: id === other.id ? other : selected ?? created, messages: [] }));
}
beforeEach(async () => {
  await persistence.clearAll();
  vi.resetAllMocks();
  localStorage.clear(); sessionStorage.clear(); resetComposerDraft(); window.history.replaceState(null, "", "/");
  localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, "alpha");
  vi.stubGlobal("EventSource", FixtureEventSource);
  fixture = installVoiceFixture();
  nextUpload = 0; uploads = new Map();
  vi.mocked(api.createUpload).mockImplementation(async (file) => {
    const value = attachment(`audio-upload-${++nextUpload}`, { name: file.name, contentType: file.type, sizeBytes: file.size });
    uploads.set(value.id, value); return value;
  });
  vi.mocked(uploadContent).mockImplementation(async (value) => {
    const uploaded = { ...value, uploaded: true }; uploads.set(value.id, uploaded); return uploaded;
  });
  vi.mocked(api.deleteUpload).mockResolvedValue(undefined);
  seed();
  vi.mocked(api.activeThreads).mockResolvedValue({ threads: [], total: 0, truncated: false, runningCounts: {} });
  vi.mocked(api.agentSkills).mockResolvedValue({ status: "unsupported", items: [] });
  vi.mocked(api.projects).mockResolvedValue([]); vi.mocked(api.listTags).mockResolvedValue([]);
  vi.mocked(api.projectThreads).mockResolvedValue({ threads: [] }); vi.mocked(api.messages).mockResolvedValue({ messages: [] });
  vi.mocked(api.createThread).mockResolvedValue(created);
  vi.mocked(api.transcribe).mockResolvedValue({ text: "A synthetic voice request." });
  vi.mocked(api.submit).mockImplementation(async (threadId, submissionId) => ({ threadId, submissionId, outcome: "turn" }));
});
afterEach(async () => { await commands.emulateColorScheme(null); cleanup(); fixture.restore(); await persistence.clearAll(); localStorage.clear(); resetComposerDraft(); });
async function openRecordingMenu() {
  // Store readiness precedes the external adapter's passive snapshot update.
  // Chat keys the composer by that snapshot, so an awaited DOM node can already
  // be detached by the time Vitest generates its native click selector.
  await waitFor(() => {
    expect(store.bootstrap).toBeTruthy();
    expect(store.loading || store.selectionLoading || store.detailLoading).toBe(false);
    expect(runtime.thread.getState().extras).toMatchObject({ selectedThreadId: store.selectedThreadId });
  });
  const trigger = page.getByRole("button", { name: "Add attachment", exact: true });
  await trigger.click();
  await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
  const option = page.getByRole("menuitem", { name: "Record audio", exact: true });
  await expect.element(option).toBeVisible();
  await expect.element(option).toHaveAttribute("aria-disabled", "false");
  return option;
}
async function record() {
  const option = await openRecordingMenu();
  await option.click();
  await screen.findByRole("button", { name: "Stop recording" });
}
async function stop() {
  await userEvent.click(screen.getByRole("button", { name: "Stop recording" }));
  await waitFor(() => expect(screen.queryByText("Attaching recording…")).toBeNull());
  await screen.findAllByText("recording.webm");
}
async function send() {
  const button = screen.getByRole("button", { name: "Send message" });
  await waitFor(() => expect(button).toBeEnabled()); await userEvent.click(button);
}
const shots = import.meta.env.VITE_VOICE_SHOTS as string | undefined;
const shot = async (name: string) => { if (shots) await page.screenshot({ path: `${shots}/attachments-synthetic-${name}.png` }); };
function message(id: string, threadId: string, role: WebMessage["role"], text: string): WebMessage {
  return { id, threadId, role, parts: [{ type: "text", text }], attachments: [], status: "complete", seq: 0,
    createdAt: "2026-07-17T10:00:00.000Z", updatedAt: "2026-07-17T10:00:00.000Z" };
}

describe("recorded audio through actual Chat, Composer, ordinary uploads and submissions", () => {
  for (const [width, height, device] of [[1280, 900, "desktop"], [390, 844, "mobile"], [320, 740, "narrow"]] as const) {
    for (const scheme of ["light", "dark"] as const) {
      it(`${device} ${scheme}: normal text + two recordings + file, cached preparation and exact retry`, async () => {
        await page.viewport(width, height); await commands.emulateColorScheme(scheme);
        let selected = { ...created, title: "A small garden project" };
        seed(selected);
        const history = [message("garden-user", selected.id, "user", "Let’s plan a small balcony garden."),
          message("garden-reply", selected.id, "assistant", "Start with herbs in a sunny spot. What would you like to grow?")];
        vi.mocked(api.thread).mockResolvedValue({ thread: selected, messages: history });
        vi.mocked(api.patchThread).mockImplementation(async (_id, patch) => {
          selected = { ...selected, ...(patch.model === undefined ? {} : { runModel: patch.model }), ...(patch.effort === undefined ? {} : { runEffort: patch.effort }), ...(patch.context1M === undefined ? {} : { runContext1M: patch.context1M }) };
          return selected;
        });
        const view = mount();
        await waitFor(() => expect(store.detail?.thread.id).toBe(selected.id));
        const input = await screen.findByRole("combobox", { name: "Message" });
        await userEvent.fill(input, "Include easy-care herbs.");
        await act(async () => runtime.thread.composer.addAttachment(new File(["A small plant list."], "plants.txt", { type: "text/plain" })));
        act(() => runtime.thread.composer.setQuote({ messageId: "garden-user", text: "small balcony garden" }));
        const checkLayout = () => {
          expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
          for (const control of view.container.querySelectorAll<HTMLElement>(".composer-toolbar button, .recording-draft button")) {
            const rect = control.getBoundingClientRect(); if (!rect.width) continue;
            expect(rect.left).toBeGreaterThanOrEqual(0); expect(rect.right).toBeLessThanOrEqual(width);
            expect(control.scrollWidth).toBeLessThanOrEqual(control.clientWidth + 1);
          }
        };
        const capture = (state: string) => shot(`${device}-${scheme}-${state}`);
        await userEvent.click(screen.getByRole("button", { name: "Add attachment" }));
        await screen.findByRole("menuitem", { name: "Upload files" });
        expect(screen.queryByRole("button", { name: "Record voice message" })).toBeNull();
        await capture("01-menu");
        await userEvent.click(screen.getByRole("menuitem", { name: "Record audio" }));
        await screen.findByRole("button", { name: "Stop recording" });
        expect(input).toBeEnabled(); expect(input).toHaveValue("Include easy-care herbs.");
        expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
        expect(screen.getByRole("timer")).toHaveAttribute("aria-live", "off");
        await userEvent.click(input); await userEvent.keyboard("{Control>}{Enter}{/Control}");
        expect(api.submit).not.toHaveBeenCalled(); expect(screen.getByRole("button", { name: "Stop recording" })).toBeVisible();
        checkLayout(); await capture("02-recording-with-draft");
        await stop();
        expect(api.submit).not.toHaveBeenCalled(); expect(api.transcribe).not.toHaveBeenCalled();
        expect(input).toHaveValue("Include easy-care herbs."); expect(screen.getByText("plants.txt")).toBeVisible();
        checkLayout(); await capture("03-audio-draft");
        await userEvent.click(screen.getByRole("button", { name: "Preview recording.webm" }));
        const audio = await screen.findByLabelText("Audio recording.webm");
        const bounds = audio.getBoundingClientRect();
        expect(bounds.bottom).toBeLessThanOrEqual(audio.closest(".composer-attachments")!.getBoundingClientRect().bottom + 1);
        const previewUrl = audio.getAttribute("src"); const revoke = vi.spyOn(URL, "revokeObjectURL");
        checkLayout(); await capture("04-playback");
        await userEvent.click(screen.getByRole("button", { name: "Preview recording.webm" }));
        expect(revoke).toHaveBeenCalledWith(previewUrl); revoke.mockRestore();
        await record(); await stop();
        act(() => store.setModel("provider/other"));
        await waitFor(() => expect(store.effectiveModel).toBe("provider/other"));
        vi.mocked(api.transcribe).mockResolvedValueOnce({ text: "Add basil." }).mockRejectedValueOnce(new Error("Synthetic transcription failure. Retry Send."));
        await send();
        await screen.findByText("Synthetic transcription failure. Retry Send.");
        await waitFor(() => expect(screen.getByRole("combobox", { name: "Message" })).toHaveValue("Include easy-care herbs."));
        expect(api.submit).not.toHaveBeenCalled(); expect(api.createUpload).toHaveBeenCalledTimes(3);
        checkLayout(); await capture("05-preparation-failure");
        let resolveTranscript!: (value: { text: string }) => void;
        vi.mocked(api.transcribe).mockImplementationOnce(() => new Promise((resolve) => { resolveTranscript = resolve; }));
        vi.mocked(api.submit).mockRejectedValueOnce(new Error("Acknowledgement unavailable"));
        vi.mocked(api.submission).mockRejectedValueOnce(new Error("Receipt unavailable"));
        await send(); await screen.findByText("Preparing message…");
        checkLayout(); await capture("06-preparing");
        act(() => store.setModel("provider/model"));
        await act(async () => resolveTranscript({ text: "Grow mint in its own pot." }));
        await screen.findByRole("button", { name: "Check / retry send" });
        const first = vi.mocked(api.submit).mock.calls[0]!;
        expect(first[2]).toMatchObject({ text: 'Include easy-care herbs.\n\nAudio transcript 1 ("recording.webm"):\nAdd basil.\n\nAudio transcript 2 ("recording.webm"):\nGrow mint in its own pot.',
          attachmentIds: ["audio-upload-1", "audio-upload-2", "audio-upload-3"], model: "provider/other", inheritRunSettings: false, quote: { messageId: "garden-user", text: "small balcony garden" } });
        expect(api.transcribe).toHaveBeenCalledTimes(3); // Successful first recording was cached.
        await userEvent.fill(screen.getByRole("combobox", { name: "Message" }), "A later draft stays separate.");
        checkLayout(); await capture("07-receipt-recovery");
        await userEvent.click(screen.getByRole("button", { name: "Check / retry send" }));
        await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(screen.queryByRole("button", { name: "Check / retry send" })).toBeNull());
        expect(vi.mocked(api.submit).mock.calls[1]).toEqual(first);
        expect(api.transcribe).toHaveBeenCalledTimes(3); expect(api.createUpload).toHaveBeenCalledTimes(3);
        expect(screen.getByRole("combobox", { name: "Message" })).toHaveValue("A later draft stays separate.");
        const sent = { ...message("garden-sent", selected.id, "user", first[2].text!), attachments: [...uploads.values()].map((value) => ({ ...value, status: "committed" as const, contentUrl: `/api/v1/uploads/${value.id}/content` })) };
        const reply = message("garden-answer", selected.id, "assistant", "Basil and mint are on the plan.");
        vi.mocked(api.thread).mockResolvedValue({ thread: { ...selected, messageCount: 4, revision: 2 }, messages: [...history, sent, reply] });
        act(() => FixtureEventSource.current.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ version: 1, type: "message.changed", at: reply.createdAt, threadId: selected.id, payload: { messageId: sent.id } }) })));
        await screen.findByText(reply.parts[0]!.type === "text" ? reply.parts[0]!.text : "");
        expect(screen.getAllByRole("link", { name: "Download recording.webm" })).toHaveLength(2);
        checkLayout(); await capture("08-sent-attachments");
      });
    }
  }
  it("opens the current composer's recording menu through trusted native clicks", async () => {
    seed(created); mount();
    const clicks: { name: string; trusted: boolean; connected: boolean }[] = [];
    const observe = (event: MouseEvent) => {
      const target = event.target instanceof Element
        ? event.target.closest('button[aria-label="Add attachment"], [role="menuitem"]') : null;
      if (target) clicks.push({ name: target.getAttribute("aria-label") ?? target.textContent!.trim(),
        trusted: event.isTrusted, connected: target.isConnected });
    };
    document.addEventListener("click", observe, true);
    try {
      await record();
      expect(clicks).toEqual([
        { name: "Add attachment", trusted: true, connected: true },
        { name: "Record audio", trusted: true, connected: true },
      ]);
      expect(runtime.thread.getState().extras).toMatchObject({ selectedThreadId: created.id });
      expect(fixture.getUserMedia).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: "Cancel recording" })).toBeVisible();
    } finally { document.removeEventListener("click", observe, true); }
  });
  it.each(["resolve", "reject"] as const)("stale attachment retry cannot change a newer live recording when it later %ss", async (outcome) => {
    seed(created); mount(); await record();
    vi.mocked(api.createUpload).mockRejectedValueOnce(new Error("Synthetic reservation refusal"));
    await userEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    const retry = await screen.findByRole("button", { name: "Retry attachment" });
    let resolve!: (value: import("./types").WebAttachment) => void; let reject!: (error: Error) => void;
    vi.mocked(api.createUpload).mockImplementationOnce(() => new Promise((done, fail) => { resolve = done; reject = fail; }));
    await userEvent.click(retry); await screen.findByText("Attaching recording…");
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    try { act(() => document.dispatchEvent(new Event("visibilitychange"))); } finally { hidden.mockRestore(); }
    await waitFor(() => expect(screen.queryByText("Attaching recording…")).toBeNull());
    await record();
    const freshRecorder = FixtureMediaRecorder.instances.at(-1)!;
    await act(async () => {
      if (outcome === "resolve") resolve(attachment("retired-retry", { name: "recording.webm", contentType: "audio/webm", sizeBytes: 7 }));
      else reject(new Error("Stale reservation error"));
    });
    expect(screen.getByRole("button", { name: "Stop recording" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel recording" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(freshRecorder.state).toBe("recording"); expect(fixture.stop).toHaveBeenCalledTimes(2);
    expect(runtime.thread.composer.getState().attachments).toHaveLength(0);
    expect(screen.queryByText("Stale reservation error")).toBeNull();
    if (outcome === "resolve") await waitFor(() => expect(api.deleteUpload).toHaveBeenCalledWith("retired-retry"));
    expect(api.submit).not.toHaveBeenCalled(); expect(api.transcribe).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Cancel recording" }));
    expect(freshRecorder.state).toBe("inactive"); expect(fixture.stop).toHaveBeenCalledTimes(4);
  });
  it.each([320, 390])("complete failed audio chip Retry/Remove controls fit at %spx", async (width) => {
    await page.viewport(width, 844); await commands.emulateColorScheme("light"); seed(created); mount();
    await waitFor(() => expect(store.detail?.thread.id).toBe(created.id));
    await screen.findByRole("button", { name: "Add attachment" });
    await act(async () => runtime.thread.composer.addAttachment(new File(["notes"], "notes.txt", { type: "text/plain" })));
    await record(); vi.mocked(uploadContent).mockRejectedValueOnce(new Error("Synthetic transfer refusal"));
    await userEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    const retry = await screen.findByRole("button", { name: "Retry upload" });
    const chip = retry.closest<HTMLElement>(".attachment-chip")!;
    const viewport = chip.closest<HTMLElement>(".composer-attachments")!.getBoundingClientRect();
    const bounds = chip.getBoundingClientRect();
    expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(width);
    expect(bounds.top).toBeGreaterThanOrEqual(viewport.top); expect(bounds.bottom).toBeLessThanOrEqual(viewport.bottom + 1);
    for (const button of within(chip).getAllByRole("button")) {
      const rect = button.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(bounds.left); expect(rect.right).toBeLessThanOrEqual(bounds.right);
      expect(rect.top).toBeGreaterThanOrEqual(bounds.top); expect(rect.bottom).toBeLessThanOrEqual(bounds.bottom);
      expect(rect.width).toBeGreaterThanOrEqual(44); expect(rect.height).toBeGreaterThanOrEqual(44);
      expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth + 1);
    }
    await shot(`failed-upload-${width}`);
    await userEvent.click(within(chip).getByRole("button", { name: "Remove file" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry upload" })).toBeNull());
  });
  it("same-tick composer sends consume the recorded attachments only once", async () => {
    seed(created); mount(); await record(); await stop();
    let resolve!: (value: { text: string }) => void;
    vi.mocked(api.transcribe).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await act(async () => { await Promise.all([runtime.thread.composer.send(), runtime.thread.composer.send()]); });
    await waitFor(() => expect(api.transcribe).toHaveBeenCalledTimes(1));
    await act(async () => resolve({ text: "One request" }));
    await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(1));
  });
  it("same-tick real runtime queue appends deduplicate identical recorded attachment intent", async () => {
    seed(created); mount(); await record(); await stop();
    const attachments = await Promise.all(runtime.thread.composer.getState().attachments.map((item) => recorded.adapter.send(item as PendingAttachment)));
    await act(async () => runtime.thread.composer.setText(""));
    let resolve!: (value: { text: string }) => void;
    vi.mocked(api.transcribe).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const capture = vi.spyOn(store, "captureAttachmentSubmission");
    const input = { role: "user" as const, content: [{ type: "text" as const, text: "Original intent" }], attachments, parentId: null };
    await act(async () => { await Promise.all([runtime.thread.append(input), runtime.thread.append(input)]); });
    expect(capture).toHaveBeenCalledTimes(1); expect(api.transcribe).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ text: "One transcript" }));
    await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(1));
  });
  it("real queue preserves a newer draft without lending it the admitted recording", async () => {
    seed(created); mount(); await record(); await stop();
    const attachments = await Promise.all(runtime.thread.composer.getState().attachments.map((item) => recorded.adapter.send(item as PendingAttachment)));
    let resolve!: (value: { text: string }) => void;
    vi.mocked(api.transcribe).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await userEvent.fill(screen.getByRole("combobox", { name: "Message" }), "Original");
    await act(async () => runtime.thread.composer.send());
    await act(async () => runtime.thread.append({ role: "user", content: [{ type: "text", text: "Newer draft" }], attachments, parentId: null }));
    expect(api.transcribe).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Message" })).toHaveValue("Newer draft"));
    expect(runtime.thread.composer.getState().attachments).toHaveLength(0);
    await act(async () => resolve({ text: "Original transcript" }));
    await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(1));
    await send(); await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.submit).mock.calls[1]![2].text).toBe("Newer draft");
    expect(vi.mocked(api.submit).mock.calls[1]![1]).not.toBe(vi.mocked(api.submit).mock.calls[0]![1]);
    expect(api.transcribe).toHaveBeenCalledTimes(1);
  });
  it("recorded queue input waits behind an ordinary synchronous admission and stays recoverable", async () => {
    seed(created); mount(); await record(); await stop();
    const attachments = await Promise.all(runtime.thread.composer.getState().attachments.map((item) => recorded.adapter.send(item as PendingAttachment)));
    let resolve!: (value: import("./types").SubmissionReceipt) => void;
    vi.mocked(api.submit).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await act(async () => {
      await Promise.all([
        runtime.thread.append({ role: "user", content: [{ type: "text", text: "Earlier ordinary request" }], parentId: null }),
        runtime.thread.append({ role: "user", content: [], attachments, parentId: null }),
      ]);
    });
    await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(1)); expect(api.transcribe).not.toHaveBeenCalled();
    const id = vi.mocked(api.submit).mock.calls[0]![1];
    await act(async () => resolve({ threadId: created.id, submissionId: id, outcome: "turn" }));
    await send(); await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(2));
    expect(api.transcribe).toHaveBeenCalledTimes(1);
  });
  it("cancel and permission denial preserve typed text, quote and an existing file, without sending", async () => {
    seed(created); mount();
    await waitFor(() => expect(store.detail?.thread.id).toBe(created.id));
    const input = await screen.findByRole("combobox", { name: "Message" });
    await userEvent.fill(input, "Keep this draft.");
    await act(async () => runtime.thread.composer.addAttachment(new File(["notes"], "notes.txt", { type: "text/plain" })));
    act(() => runtime.thread.composer.setQuote({ messageId: "fictional", text: "A quote to keep" }));
    await record(); await userEvent.click(screen.getByRole("button", { name: "Cancel recording" }));
    expect(input).toHaveValue("Keep this draft."); expect(screen.getByText("notes.txt")).toBeVisible();
    expect(runtime.thread.composer.getState().quote?.text).toBe("A quote to keep");
    fixture.getUserMedia.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
    const deniedOption = await openRecordingMenu();
    await deniedOption.click();
    expect(await screen.findByRole("alert")).toHaveTextContent("permission denied");
    expect(input).toHaveValue("Keep this draft."); expect(api.transcribe).not.toHaveBeenCalled(); expect(api.submit).not.toHaveBeenCalled();
  });
  it("generic audio from Upload files is never automatically transcribed", async () => {
    seed(created); mount(); await waitFor(() => expect(store.detail?.thread.id).toBe(created.id)); await screen.findByRole("button", { name: "Add attachment" });
    await act(async () => runtime.thread.composer.addAttachment(new File(["synthetic"], "ordinary.webm", { type: "audio/webm" })));
    await send(); await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(1));
    expect(api.transcribe).not.toHaveBeenCalled(); expect(vi.mocked(api.submit).mock.calls[0]![2].attachmentIds).toHaveLength(1);
  });
  it.each(["reservation", "transfer"] as const)("retains recording intent and bytes across a failed %s, then retries an ordinary upload", async (failure) => {
    seed(created); mount(); await record();
    if (failure === "reservation") vi.mocked(api.createUpload).mockRejectedValueOnce(new Error("Synthetic upload reservation failure"));
    else vi.mocked(uploadContent).mockRejectedValueOnce(new Error("Synthetic upload transfer failure"));
    await userEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    const retry = await screen.findByRole("button", { name: failure === "reservation" ? "Retry attachment" : "Retry upload" });
    expect(api.submit).not.toHaveBeenCalled(); expect(api.transcribe).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    await userEvent.click(screen.getByRole("combobox", { name: "Message" })); await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(api.submit).not.toHaveBeenCalled();
    await userEvent.click(retry); await send();
    await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(1));
    expect(api.createUpload).toHaveBeenCalledTimes(2); expect(api.transcribe).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.transcribe).mock.calls[0]![1].size).toBe(7);
  });
  it.each(["remove", "navigate"] as const)("does not resurrect a recording when an in-flight upload is cancelled by %s", async (action) => {
    seed(created); mount(); await record();
    let uploadSignal: AbortSignal | undefined;
    vi.mocked(uploadContent).mockImplementationOnce((_upload, _file, _progress, signal) => new Promise((_resolve, reject) => {
      uploadSignal = signal; signal!.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
    }));
    await userEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    await screen.findByText("Attaching recording…");
    if (action === "remove") await userEvent.click(screen.getByRole("button", { name: "Remove file" }));
    else act(() => store.selectThread(other.id));
    await waitFor(() => expect(uploadSignal?.aborted).toBe(true));
    await waitFor(() => expect(screen.queryByText("Attaching recording…")).toBeNull());
    expect(screen.queryByRole("button", { name: "Retry attachment" })).toBeNull();
    expect(runtime.thread.composer.getState().attachments).toHaveLength(0);
    expect(api.submit).not.toHaveBeenCalled(); expect(api.transcribe).not.toHaveBeenCalled();
    await record(); await userEvent.click(screen.getByRole("button", { name: "Cancel recording" }));
  });
  it("hiding the tab cancels preparation, restores owned attachments and ignores a late transcript", async () => {
    seed(created); mount(); await record(); await stop();
    let resolve!: (value: { text: string }) => void;
    vi.mocked(api.transcribe).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await send(); await waitFor(() => expect(api.transcribe).toHaveBeenCalledTimes(1));
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    try { act(() => document.dispatchEvent(new Event("visibilitychange"))); }
    finally { hidden.mockRestore(); }
    await screen.findByText("Audio preparation cancelled. Your draft and files are kept.");
    expect(vi.mocked(api.transcribe).mock.calls[0]![2]!.aborted).toBe(true);
    await act(async () => resolve({ text: "Stale synthetic transcript" }));
    await send(); await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(1));
    expect(api.transcribe).toHaveBeenCalledTimes(2); expect(api.createUpload).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.submit).mock.calls[0]![2].text).not.toContain("Stale synthetic transcript");
  });
  it("pre-dispatch failure restores owned text/files without overwriting a newer draft or quote", async () => {
    seed(created); mount(); await record(); await stop();
    await userEvent.fill(screen.getByRole("combobox", { name: "Message" }), "Original authored text.");
    let reject!: (error: Error) => void;
    vi.mocked(api.transcribe).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    await send(); await waitFor(() => expect(api.transcribe).toHaveBeenCalledTimes(1));
    await userEvent.fill(screen.getByRole("combobox", { name: "Message" }), "Newer authored text.");
    act(() => runtime.thread.composer.setQuote({ messageId: "newer-fictional", text: "Newer quote" }));
    await act(async () => runtime.thread.composer.addAttachment(new File(["new"], "newer.txt", { type: "text/plain" })));
    await act(async () => reject(new Error("Synthetic preparation refusal")));
    await screen.findByText("Synthetic preparation refusal");
    expect(screen.getByRole("combobox", { name: "Message" })).toHaveValue("Original authored text.\n\nNewer authored text.");
    expect(runtime.thread.composer.getState().quote?.text).toBe("Newer quote");
    expect(screen.getByText("newer.txt")).toBeVisible(); expect(screen.getByText("recording.webm")).toBeVisible();
    expect(api.submit).not.toHaveBeenCalled(); expect(api.createUpload).toHaveBeenCalledTimes(2);
  });
  it("navigation after uncertain dispatch and reload keep receipt references only, never reconstructing or autosending", async () => {
    seed(created); const view = mount(); await record(); await stop();
    vi.mocked(api.submit).mockRejectedValueOnce(new Error("Uncertain dispatch"));
    vi.mocked(api.submission).mockRejectedValueOnce(new Error("Receipt unavailable"));
    await send(); await screen.findByRole("button", { name: "Check / retry send" });
    const attemptId = vi.mocked(api.submit).mock.calls[0]![1];
    expect(sessionStorage.getItem("mono-agent.web.pending-submissions")).toContain(attemptId);
    act(() => store.selectThread(other.id)); await waitFor(() => expect(store.detail?.thread.id).toBe(other.id));
    await userEvent.fill(screen.getByRole("combobox", { name: "Message" }), "Destination draft.");
    act(() => store.selectThread(created.id)); await waitFor(() => expect(store.detail?.thread.id).toBe(created.id));
    expect(screen.queryByRole("button", { name: "Check / retry send" })).toBeNull();
    expect(runtime.thread.composer.getState().attachments).toHaveLength(0); expect(api.deleteUpload).not.toHaveBeenCalled();
    vi.mocked(api.submission).mockResolvedValue({ submissionId: attemptId, threadId: created.id, outcome: "turn" });
    view.unmount(); mount();
    await waitFor(() => expect(api.submission).toHaveBeenCalledWith(created.id, attemptId));
    expect(api.submit).toHaveBeenCalledTimes(1); expect(api.transcribe).toHaveBeenCalledTimes(1);
    expect(runtime.thread.composer.getState().attachments).toHaveLength(0);
  });
  it("only recording Stop is shown during capture, and an audio draft waits for an active response", async () => {
    seed({ ...created, runState: { id: "running-one", status: "running" } }); mount();
    await screen.findByRole("button", { name: "Stop response" });
    await record(); expect(screen.queryByRole("button", { name: "Stop response" })).toBeNull();
    await stop(); expect(screen.getByRole("button", { name: "Stop response" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(api.cancelTurn).not.toHaveBeenCalled(); expect(api.submit).not.toHaveBeenCalled(); expect(api.transcribe).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Remove file" }));
    expect(runtime.thread.composer.getState().attachments).toHaveLength(0);
  });
  it.each(["permission", "transcription"] as const)("navigation fences late %s and recovers the destination composer", async (phase) => {
    seed(created); mount();
    let resolvePermission!: (stream: MediaStream) => void;
    let resolveTranscript!: (value: { text: string }) => void;
    if (phase === "permission") {
      fixture.getUserMedia.mockImplementationOnce(() => new Promise((resolve) => { resolvePermission = resolve; }));
      const pendingOption = await openRecordingMenu();
      await pendingOption.click();
      await screen.findByText("Allow microphone access…");
    } else {
      await record(); await stop();
      vi.mocked(api.transcribe).mockImplementationOnce(() => new Promise((resolve) => { resolveTranscript = resolve; }));
      await send(); await waitFor(() => expect(api.transcribe).toHaveBeenCalledTimes(1));
    }
    act(() => store.selectThread(other.id));
    await waitFor(() => expect(store.selectionLoading).toBe(false));
    expect(screen.getByRole("combobox", { name: "Message" })).toBeEnabled();
    if (phase === "permission") await act(async () => resolvePermission(fixture.stream));
    else await act(async () => resolveTranscript({ text: "Stale recording text" }));
    expect(api.submit).not.toHaveBeenCalled(); expect(runtime.thread.composer.getState().attachments).toHaveLength(0);
    expect(fixture.stop).toHaveBeenCalledTimes(2);
    act(() => store.selectThread(created.id));
    await waitFor(() => expect(store.selectionLoading).toBe(false));
    expect(runtime.thread.composer.getState().attachments).toHaveLength(0);
  });
  it("preserves the staged audio across its owned keyed new-thread handoff", async () => {
    let resolveCreate!: (value: ThreadSummary) => void;
    vi.mocked(api.createThread).mockImplementationOnce(() => new Promise((resolve) => { resolveCreate = resolve; }));
    const view = mount(); await record(); await stop();
    const input = screen.getByRole("combobox", { name: "Message" });
    await send(); await waitFor(() => expect(store.creatingThread).toBe(true));
    expect(input.isConnected).toBe(false); expect(api.deleteUpload).not.toHaveBeenCalled();
    await act(async () => resolveCreate(created));
    await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(1));
    expect(api.transcribe).toHaveBeenCalledTimes(1); expect(api.createUpload).toHaveBeenCalledTimes(1);
    expect(api.submit).toHaveBeenCalledWith(created.id, expect.any(String), expect.objectContaining({ attachmentIds: ["audio-upload-1"], inheritRunSettings: false }));
    expect(view.container.querySelector(".composer-root")).toBeInTheDocument();
  });
  it.each(["resolve", "reject"] as const)("cancelled creation cannot consume a newer null-thread draft/settings when it later %ss", async (outcome) => {
    let resolve!: (value: ThreadSummary) => void; let reject!: (error: Error) => void;
    vi.mocked(api.createThread).mockImplementationOnce(() => new Promise((done, fail) => { resolve = done; reject = fail; }));
    mount(); await record(); await stop(); await send();
    await waitFor(() => expect(store.creatingThread).toBe(true));
    act(() => { store.setConversationVisible(false); writeComposerDraft("alpha", null, "A newer fictional draft."); store.setModel("provider/other"); });
    await act(async () => { if (outcome === "resolve") resolve(created); else reject(new Error("Synthetic refusal")); });
    expect(readComposerDraft("alpha", null)).toBe("A newer fictional draft.");
    expect(store.model).toBe("provider/other"); expect(api.submit).not.toHaveBeenCalled(); expect(api.transcribe).not.toHaveBeenCalled();
    act(() => store.setConversationVisible(true));
  });
  it.skipIf(!navigator.userAgent.includes("Chrome"))("stages real MediaRecorder container bytes from Chromium’s synthetic microphone before normal Send", async () => {
    fixture.restore(); vi.stubGlobal("EventSource", FixtureEventSource);
    seed(created); mount();
    const start = MediaRecorder.prototype.start;
    let receivedChunks = 0;
    const spy = vi.spyOn(MediaRecorder.prototype, "start").mockImplementation(function (this: MediaRecorder, timeslice) {
      this.addEventListener("dataavailable", (event) => { if (event.data.size > 0) receivedChunks++; });
      start.call(this, timeslice);
    });
    try {
      await record(); await waitFor(() => expect(receivedChunks).toBeGreaterThanOrEqual(2)); await stop();
      const file = vi.mocked(api.createUpload).mock.calls[0]![0];
      expect(file.type).toBe("audio/webm"); expect(file.size).toBeGreaterThan(100);
      const bytes = new Uint8Array(await file.arrayBuffer()); expect([...bytes.slice(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
      expect(bytes.some((value, index) => value === 0x1f && bytes[index + 1] === 0x43 && bytes[index + 2] === 0xb6 && bytes[index + 3] === 0x75)).toBe(true); // WebM audio cluster, not a header-only artifact.
      if (shots) await commands.saveVoiceFixture([...bytes]);
      expect(api.submit).not.toHaveBeenCalled(); expect(api.transcribe).not.toHaveBeenCalled();
      await send(); await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(1));
      expect(vi.mocked(api.transcribe).mock.calls[0]![1]).toBe(file);
    } finally { spy.mockRestore(); }
  });
  it("leaving to an inert conversation with body focus never attempts to refocus it", async () => {
    seed(created); const view = mount(); await record();
    const shell = view.container.querySelector<HTMLElement>(".voice-console-fixture")!;
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const navigation = render(<button type="button" onClick={() => { store.setConversationVisible(false); shell.inert = true; navigation.unmount(); }}>Leave synthetic conversation</button>);
    try {
      await userEvent.click(screen.getByRole("button", { name: "Leave synthetic conversation" }));
      await waitFor(() => expect(shell.querySelector(".recording-draft")).toBeNull());
      expect(document.activeElement).toBe(document.body);
      expect(focus.mock.contexts.filter((element) => element instanceof Node && shell.contains(element))).toHaveLength(0);
    } finally { focus.mockRestore(); }
  });
});
