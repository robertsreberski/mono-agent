import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { commands, page, userEvent } from "@vitest/browser/context";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { ConsoleStoreProvider, RUN_PREFERENCES_STORAGE_KEY, SELECTED_AGENT_STORAGE_KEY, preferenceKeyForThread, useConsoleStore } from "./console-store";
import { COMPOSER_DRAFTS_STORAGE_KEY, flushComposerDrafts, readComposerDraft, resetComposerDraft, writeComposerDraft } from "./composer-draft";
import { VoiceComposer } from "./components/VoiceComposer";
import { WebRuntimeProvider } from "./runtime";
import { Chat } from "./components/Chat";
import { agent, bootstrap, thread } from "./test/fixtures";
import { installVoiceFixture } from "./test/voice-fixtures";
import { createThreadPersistence } from "./thread-persistence";
import type { ThreadSummary, WebMessage } from "./types";
import "./styles.css";

vi.mock("./api", async (original) => ({
  ...await original<typeof import("./api")>(),
  api: {
    bootstrap: vi.fn(), activeThreads: vi.fn(), thread: vi.fn(), threads: vi.fn(), messages: vi.fn(),
    createThread: vi.fn(), patchThread: vi.fn(), agentSkills: vi.fn(), agentModels: vi.fn(),
    submit: vi.fn(), submission: vi.fn(), transcribe: vi.fn(), cancelTurn: vi.fn(), cronOverview: vi.fn(),
    projects: vi.fn(), projectThreads: vi.fn(), listTags: vi.fn(),
  },
}));
vi.mock("./notifications", () => ({ NotificationBell: () => null }));
class FixtureEventSource {
  static current: FixtureEventSource;
  constructor() { FixtureEventSource.current = this; }
  readyState = 1; onopen = null; onmessage: ((event: MessageEvent) => void) | null = null; onerror = null;
  addEventListener() {} removeEventListener() {} close() {}
}
const persistence = createThreadPersistence();
let fixture: ReturnType<typeof installVoiceFixture>;
let store: ReturnType<typeof useConsoleStore>;
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
    <div className="voice-console-fixture" style={{ height: "100dvh", display: "flex", flexDirection: "column", maxWidth: 1000, margin: "auto" }}>
      <Chat onBack={() => store.setConversationVisible(false)} />
    </div>
  </WebRuntimeProvider></ConsoleStoreProvider>);
}
function seed(selected?: ThreadSummary) {
  vi.mocked(api.bootstrap).mockResolvedValue({ ...bootstrap([fixtureAgent], selected ? [selected, other] : [], selected?.id), voice: { enabled: true, maxBytes: 10485760, maxSeconds: 120, maxTextCharacters: 8000 } });
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
async function record() {
  await waitFor(() => expect(screen.getByRole("button", { name: "Record voice message" })).toHaveAttribute("aria-disabled", "false"));
  await userEvent.click(screen.getByRole("button", { name: "Record voice message" }));
  await screen.findByRole("button", { name: "Stop recording" });
}
async function stop() {
  await userEvent.click(screen.getByRole("button", { name: "Stop recording" }));
  await screen.findByRole("button", { name: "Send voice message" });
}
const shots = import.meta.env.VITE_VOICE_SHOTS as string | undefined;
const shot = async (name: string) => { if (shots) await page.screenshot({ path: `${shots}/console-synthetic-${name}.png` }); };

describe("voice through real mounted Chat, keyed Composer, runtime and store", () => {
  it.each([[1280, 900, "desktop"], [390, 844, "mobile"]] as const)("retains only its owned new-thread handoff at %ipx", async (width, height, label) => {
    await page.viewport(width, height);
    let resolveCreate!: (value: ThreadSummary) => void;
    let resolveTranscript!: (value: { text: string }) => void;
    vi.mocked(api.createThread).mockImplementation(() => new Promise((resolve) => { resolveCreate = resolve; }));
    vi.mocked(api.transcribe).mockImplementation(() => new Promise((resolve) => { resolveTranscript = resolve; }));
    const { container } = mount();
    await record(); await shot(`${label}-recording`);
    await stop(); await shot(`${label}-ready`);
    const oldInput = container.querySelector("#composer-input")!;
    await userEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    await waitFor(() => expect(store.creatingThread).toBe(true));
    expect(oldInput.isConnected).toBe(false); // Real Chat unmounted the keyed composer.
    await act(async () => resolveCreate(created));
    await waitFor(() => expect(api.transcribe).toHaveBeenCalledTimes(1));
    await screen.findByText("Transcribing…");
    expect(store.selectedThreadId).toBe(created.id);
    expect(vi.mocked(api.transcribe).mock.calls[0]![2].aborted).toBe(false);
    expect(api.submit).not.toHaveBeenCalled();
    await shot(`${label}-transcribing`);
    expect(container.querySelector(".composer-root")).toBeInTheDocument();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await act(async () => resolveTranscript({ text: "A synthetic voice request." }));
    await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(1));
    expect(api.submit).toHaveBeenCalledWith(created.id, expect.any(String), expect.objectContaining({ text: "A synthetic voice request.", model: "provider/model", effort: "medium", inheritRunSettings: false }));
    expect(api.createThread).toHaveBeenCalledTimes(1);
    expect(fixture.stop).toHaveBeenCalledTimes(2);
  });
  it.each([
    ["resolve", other], ["reject", other], ["resolve", created], ["reject", created],
  ] as const)("recovers immediately after single navigation before create %s (%j)", async (outcome, destination) => {
    let resolveCreate!: (value: ThreadSummary) => void;
    let rejectCreate!: (error: Error) => void;
    vi.mocked(api.createThread).mockImplementation(() => new Promise((resolve, reject) => { resolveCreate = resolve; rejectCreate = reject; }));
    mount(); await record(); await stop();
    fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    await waitFor(() => expect(store.creatingThread).toBe(true));
    act(() => store.selectThread(destination.id)); // Exactly one operator navigation; stay here.
    await waitFor(() => expect(store.selectionLoading).toBe(false));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Message" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Record voice message" })).toHaveAttribute("aria-disabled", "false");
    expect(screen.queryByText("Transcribing…")).not.toBeInTheDocument();
    expect(fixture.stop).toHaveBeenCalledTimes(2);
    // Cancellation/UI recovery must happen BEFORE the old acknowledgement.
    await act(async () => { if (outcome === "resolve") resolveCreate(created); else rejectCreate(new Error("Synthetic create refusal")); });
    expect(store.selectedThreadId).toBe(destination.id);
    expect(screen.getByRole("combobox", { name: "Message" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Record voice message" })).toHaveAttribute("aria-disabled", "false");
    expect(api.transcribe).not.toHaveBeenCalled(); expect(api.submit).not.toHaveBeenCalled();
  });
  it.each(["resolve", "reject"] as const)("keeps a newer recording when a cancelled creation later %ss", async (outcome) => {
    let resolveCreate!: (value: ThreadSummary) => void;
    let rejectCreate!: (error: Error) => void;
    vi.mocked(api.createThread).mockImplementation(() => new Promise((resolve, reject) => { resolveCreate = resolve; rejectCreate = reject; }));
    mount(); await record(); await stop();
    fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    await waitFor(() => expect(store.creatingThread).toBe(true));
    act(() => store.selectThread(other.id));
    await waitFor(() => expect(store.selectionLoading).toBe(false));
    await record();
    await act(async () => { if (outcome === "resolve") resolveCreate(created); else rejectCreate(new Error("Synthetic create refusal")); });
    expect(screen.getByRole("button", { name: "Stop recording" })).toBeEnabled();
    expect(store.selectedThreadId).toBe(other.id);
    expect(api.transcribe).not.toHaveBeenCalled(); expect(api.submit).not.toHaveBeenCalled();
    await stop(); await userEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(1));
    expect(api.transcribe).toHaveBeenCalledTimes(1);
    expect(api.transcribe).toHaveBeenCalledWith(other.id, expect.any(Blob), expect.any(AbortSignal));
    expect(api.submit).toHaveBeenCalledWith(other.id, expect.any(String), expect.objectContaining({ text: "A synthetic voice request." }));
    expect(fixture.stop).toHaveBeenCalledTimes(4);
  });
  it("keeps an owned creation refusal retryable without losing the recording", async () => {
    vi.mocked(api.createThread).mockRejectedValueOnce(new Error("Synthetic create refusal")).mockResolvedValue(created);
    mount(); await record(); await stop();
    fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    await screen.findByText("Synthetic create refusal");
    await userEvent.click(await screen.findByRole("button", { name: "Send voice message" }));
    await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(1));
    expect(api.createThread).toHaveBeenCalledTimes(2); expect(api.transcribe).toHaveBeenCalledTimes(1);
    expect(fixture.getUserMedia).toHaveBeenCalledTimes(1);
    expect(api.submit).toHaveBeenCalledWith(created.id, expect.any(String), expect.objectContaining({ text: "A synthetic voice request." }));
  });
  it.each(["creating", "transcribing"] as const)("cancels real navigation while %s, even A → B → A", async (phase) => {
    let resolveCreate!: (value: ThreadSummary) => void;
    let resolveTranscript!: (value: { text: string }) => void;
    vi.mocked(api.createThread).mockImplementation(() => new Promise((resolve) => { resolveCreate = resolve; }));
    vi.mocked(api.transcribe).mockImplementation(() => new Promise((resolve) => { resolveTranscript = resolve; }));
    mount(); await record(); await stop();
    fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    await waitFor(() => expect(store.creatingThread).toBe(true));
    if (phase === "transcribing") {
      await act(async () => resolveCreate(created));
      await waitFor(() => expect(api.transcribe).toHaveBeenCalledTimes(1));
    }
    act(() => store.selectThread(other.id));
    await waitFor(() => expect(store.selectionLoading).toBe(false));
    if (phase === "creating") await act(async () => resolveCreate(created));
    act(() => store.selectThread(created.id));
    await waitFor(() => expect(store.selectionLoading).toBe(false));
    if (phase === "transcribing") {
      await act(async () => resolveTranscript({ text: "Stale synthetic request." }));
      expect(vi.mocked(api.transcribe).mock.calls[0]![2].aborted).toBe(true);
    } else expect(api.transcribe).not.toHaveBeenCalled();
    expect(api.submit).not.toHaveBeenCalled();
    expect(fixture.stop).toHaveBeenCalledTimes(2);
  });
  it.each([null, false, true])("captures inherited effective model/effort and context %s before actual setter PATCHes", async (context) => {
    let persisted = thread("inherited-voice", "alpha", { runModel: null, runEffort: null, runContext1M: context });
    seed(persisted);
    vi.mocked(api.patchThread).mockImplementation(async (_id, patch) => {
      persisted = { ...persisted, ...(patch.model === undefined ? {} : { runModel: patch.model }), ...(patch.effort === undefined ? {} : { runEffort: patch.effort }), ...(patch.context1M === undefined ? {} : { runContext1M: patch.context1M }) };
      return persisted;
    });
    mount(); await record();
    const capturedContext = store.context1M;
    let resolveTranscript: ((value: { text: string }) => void) | undefined;
    if (context === null) {
      vi.mocked(api.transcribe).mockImplementation(() => new Promise((resolve) => { resolveTranscript = resolve; }));
      await stop(); await userEvent.click(screen.getByRole("button", { name: "Send voice message" }));
      await waitFor(() => expect(api.transcribe).toHaveBeenCalledTimes(1));
    }
    expect(store.model).toBe(""); expect(store.effort).toBe("");
    expect(store.effectiveModel).toBe("provider/model"); expect(store.effectiveEffort).toBe("medium");
    act(() => store.setModel("provider/other"));
    await waitFor(() => expect(store.model).toBe("provider/other"));
    act(() => store.setEffort("high"));
    await waitFor(() => expect(store.effort).toBe("high"));
    act(() => store.setContext1M(!capturedContext));
    await waitFor(() => expect(store.context1M).toBe(!capturedContext));
    if (resolveTranscript) await act(async () => resolveTranscript!({ text: "A synthetic voice request." }));
    else { await stop(); await userEvent.click(screen.getByRole("button", { name: "Send voice message" })); }
    await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(1));
    expect(api.patchThread).toHaveBeenCalled();
    expect(api.submit).toHaveBeenCalledWith(persisted.id, expect.any(String), expect.objectContaining({ model: "provider/model", effort: "medium", context1M: capturedContext, inheritRunSettings: false }));
  });
});

// The actual Chat/Composer/runtime/store path with synthetic device and API only.
// Opt-in screenshots are deliberately clean; provenance lives beside the images.
describe("integrated compact voice presentation", () => {
  const message = (id: string, role: WebMessage["role"], text: string): WebMessage => ({
    id, threadId: "polish-thread", role, parts: [{ type: "text", text }], attachments: [],
    createdAt: "2026-07-17T10:00:00.000Z", updatedAt: "2026-07-17T10:00:00.000Z", status: "complete", seq: 0,
  });
  it("does not move focus back into a conversation after leaving it", async () => {
    seed(created);
    mount();
    await record();
    render(<button type="button" onClick={() => store.setConversationVisible(false)}>Synthetic dashboard navigation</button>);
    const navigation = screen.getByRole("button", { name: "Synthetic dashboard navigation" });
    await userEvent.click(navigation);
    await waitFor(() => expect(screen.getByRole("button", { name: "Record voice message" })).toHaveAttribute("aria-disabled", "false"));
    expect(navigation).toHaveFocus();
    expect(fixture.stop).toHaveBeenCalledTimes(2);
  });
  const longModel = "provider/long-reasoning-model-2026-preview";
  for (const [width, height, device] of [[1280, 900, "desktop"], [390, 844, "mobile"], [320, 740, "narrow"]] as const) {
    for (const scheme of ["light", "dark"] as const) {
      it(`${device} ${scheme}: toolbar placement, explicit controls, recovery and layout`, async () => {
        await page.viewport(width, height);
        await commands.emulateColorScheme(scheme);
        const selected = thread("polish-thread", "alpha", { title: "A small garden project", messageCount: 2 });
        const messages: WebMessage[] = [
          message("garden-user", "user", "Let’s plan a small balcony garden."),
          message("garden-assistant", "assistant", "Start with herbs in a sunny spot. What would you like to grow?"),
        ];
        seed(selected);
        vi.mocked(api.bootstrap).mockResolvedValue({ ...bootstrap([{ ...fixtureAgent, models: [longModel], defaultModel: longModel,
          runSettings: { config: { model: longModel, effort: "medium" }, override: null, effective: { model: longModel, effort: "medium", modelSource: "config", effortSource: "config" } },
          modelOptions: { [longModel]: { reasoning: true, effortLevels: ["low", "medium", "high"], supportsContext1M: true } } }], [selected], selected.id),
          voice: { enabled: true, maxBytes: 10485760, maxSeconds: 120, maxTextCharacters: 8000 } });
        vi.mocked(api.thread).mockResolvedValue({ thread: selected, messages });
        const { container } = mount();
        await waitFor(() => expect(screen.getByRole("button", { name: "Record voice message" })).toHaveAttribute("aria-disabled", "false"));
        const mic = screen.getByRole("button", { name: "Record voice message" });
        expect(mic.closest(".composer-tools")).not.toBeNull();
        const root = container.querySelector<HTMLElement>(".composer-root")!;
        const idleHeight = root.getBoundingClientRect().height;
        expect(idleHeight).toBeLessThan(width < 700 ? 115 : 120);
        expect(root.querySelector(".model-selector__model-name")!.getBoundingClientRect().width).toBeGreaterThanOrEqual(40);
        const checkLayout = () => {
          expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
          for (const control of root.querySelectorAll<HTMLElement>(".composer-toolbar button")) {
            const bounds = control.getBoundingClientRect();
            if (bounds.width === 0) continue;
            expect(bounds.left).toBeGreaterThanOrEqual(0);
            expect(bounds.right).toBeLessThanOrEqual(width);
            expect(control.scrollWidth).toBeLessThanOrEqual(control.clientWidth + 1);
          }
        };
        const capture = (state: string) => shot(`polished-${device}-${scheme}-${state}`);
        checkLayout(); await capture("01-idle");
        // Text still works, availability is reachable by focus/touch, not hover only.
        const input = screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement;
        fireEvent.change(input, { target: { value: "A draft to keep" } });
        input.setSelectionRange(2, 7);
        await waitFor(() => expect(mic).toHaveAttribute("aria-disabled", "true"));
        act(() => mic.focus());
        expect(screen.getByText(/Send or clear text, files and quotes/)).toBeVisible();
        fireEvent.click(mic);
        expect(fixture.getUserMedia).not.toHaveBeenCalled();
        expect(input.value).toBe("A draft to keep");
        expect(input.selectionStart).toBe(2); expect(input.selectionEnd).toBe(7);
        fireEvent.change(input, { target: { value: "" } });
        await record();
        expect(screen.queryByRole("combobox", { name: "Message" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Send voice message" })).toBeNull();
        expect(screen.getByRole("button", { name: "Stop recording" })).toHaveFocus();
        checkLayout(); await capture("02-recording");
        await stop();
        expect(screen.getByRole("button", { name: "Send voice message" })).toHaveFocus();
        expect(api.transcribe).not.toHaveBeenCalled(); expect(api.submit).not.toHaveBeenCalled();
        checkLayout(); await capture("03-ready");
        await userEvent.click(screen.getByRole("button", { name: "Cancel voice message" }));
        expect(mic.isConnected).toBe(false);
        expect(screen.getByRole("button", { name: "Record voice message" })).toHaveFocus();
        expect(screen.getByRole("combobox", { name: "Message" })).toBe(input);
        expect(root.getBoundingClientRect().height).toBe(idleHeight);
        await record(); await stop();
        vi.mocked(api.transcribe).mockRejectedValueOnce(new Error("Transcription unavailable. Try Send again."));
        await userEvent.click(screen.getByRole("button", { name: "Send voice message" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("Transcription unavailable");
        checkLayout(); await capture("04-transcription-error");
        let resolveTranscript!: (value: { text: string }) => void;
        let rejectSubmit!: (error: Error) => void;
        vi.mocked(api.transcribe).mockImplementationOnce(() => new Promise((resolve) => { resolveTranscript = resolve; }));
        vi.mocked(api.submit).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSubmit = reject; }));
        vi.mocked(api.submission).mockRejectedValueOnce(new Error("Receipt unavailable"));
        await userEvent.click(screen.getByRole("button", { name: "Send voice message" }));
        await screen.findByText("Transcribing…");
        expect(screen.getByRole("button", { name: "Cancel voice message" })).toHaveFocus();
        checkLayout(); await capture("05-transcribing");
        await act(async () => resolveTranscript({ text: "Add basil and mint to the garden plan." }));
        await screen.findByText("Submitting request…");
        expect(screen.queryByRole("button", { name: "Cancel voice message" })).toBeNull();
        expect(container.querySelector(".voice-body")).toHaveFocus();
        checkLayout(); await capture("06-submitting");
        await act(async () => rejectSubmit(new Error("Request acknowledgement unavailable.")));
        const retry = await screen.findByRole("button", { name: "Retry submission" });
        expect(retry).toHaveFocus();
        expect(screen.queryByRole("button", { name: "Cancel voice message" })).toBeNull();
        checkLayout(); await capture("07-receipt-recovery");
        const transcriptCalls = vi.mocked(api.transcribe).mock.calls.length;
        await userEvent.click(retry);
        await waitFor(() => expect(screen.getByRole("button", { name: "Record voice message" })).toHaveAttribute("aria-disabled", "false"));
        expect(api.transcribe).toHaveBeenCalledTimes(transcriptCalls);
        expect(api.submit).toHaveBeenCalledTimes(2);
        expect(vi.mocked(api.submit).mock.calls[0]).toEqual(vi.mocked(api.submit).mock.calls[1]);
        // Emulate the ordinary server refresh after the accepted synthetic receipt.
        const sent: WebMessage = message("garden-voice", "user", "Add basil and mint to the garden plan.");
        const reply: WebMessage = message("garden-reply", "assistant", "Basil and mint are on the plan. Keep mint in its own pot.");
        vi.mocked(api.thread).mockResolvedValue({ thread: { ...selected, messageCount: 4, revision: 2 }, messages: [...messages, sent, reply] });
        act(() => FixtureEventSource.current.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ version: 1, type: "message.changed", at: "2026-07-17T10:00:03.000Z", threadId: selected.id, payload: { messageId: sent.id } }) })));
        await screen.findByText("Basil and mint are on the plan. Keep mint in its own pot.");
        checkLayout(); await capture("08-submitted");
      });
    }
  }
});

// Chat deliberately hides its keyed Composer during creation. Keep the real
// voice owner mounted here to exercise explicit Cancel, then write through the
// real draft cache/setters; round-trip storage and consume the surviving draft
// only through a later ordinary creation in the real Chat.
function PendingVoiceOwner() {
  const current = useConsoleStore();
  return <VoiceComposer selectionGeneration={current.selectionGeneration} captureSubmission={current.captureVoiceSubmission} />;
}
it.each([false, true])("cancelled creation preserves fresh null-thread draft/preferences and restore (context %s)", async (context) => {
  let resolveCreate!: (value: ThreadSummary) => void;
  vi.mocked(api.createThread).mockImplementation(() => new Promise((resolve) => { resolveCreate = resolve; }));
  const pending = render(<ConsoleStoreProvider><Probe /><PendingVoiceOwner /></ConsoleStoreProvider>);
  await record(); await stop();
  fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
  await waitFor(() => expect(store.creatingThread).toBe(true));
  const generation = store.selectionGeneration;
  await userEvent.click(screen.getByRole("button", { name: "Cancel voice message" }));
  expect(screen.getByRole("button", { name: "Record voice message" })).toHaveAttribute("aria-disabled", "false");
  const fresh = "A fresh fictional text draft after Cancel.";
  writeComposerDraft("alpha", null, fresh);
  act(() => store.setModel("provider/other"));
  await waitFor(() => expect(store.model).toBe("provider/other"));
  act(() => store.setEffort("high"));
  act(() => store.setContext1M(context));
  const preference = preferenceKeyForThread("alpha", null);
  await waitFor(() => expect(JSON.parse(localStorage.getItem(RUN_PREFERENCES_STORAGE_KEY)!)[preference]).toEqual({ model: "provider/other", effort: "high", context1M: context }));
  await act(async () => resolveCreate(created));
  expect(store.selectedThreadId).toBeNull(); expect(store.selectionGeneration).toBe(generation);
  expect(store.threads.some((item) => item.id === created.id)).toBe(true);
  expect(readComposerDraft("alpha", null)).toBe(fresh);
  expect(readComposerDraft("alpha", created.id)).toBe("");
  expect(store.model).toBe("provider/other"); expect(store.effort).toBe("high"); expect(store.context1M).toBe(context);
  expect(api.transcribe).not.toHaveBeenCalled(); expect(api.submit).not.toHaveBeenCalled(); expect(api.patchThread).not.toHaveBeenCalled();
  expect(fixture.stop).toHaveBeenCalledTimes(2);
  flushComposerDrafts();
  const saved = localStorage.getItem(COMPOSER_DRAFTS_STORAGE_KEY)!;
  pending.unmount(); resetComposerDraft(); localStorage.setItem(COMPOSER_DRAFTS_STORAGE_KEY, saved);
  vi.mocked(api.bootstrap).mockResolvedValue({ ...bootstrap([fixtureAgent], [created]), voice: { enabled: true, maxBytes: 10485760, maxSeconds: 120, maxTextCharacters: 8000 } });
  vi.mocked(api.threads).mockResolvedValue({ threads: [created] });
  mount();
  await waitFor(() => expect(store.loading || store.selectionLoading).toBe(false));
  // Startup may open the most recent server thread, but cannot steal the
  // still-new draft. A later explicit creation is its legitimate consumer.
  expect(readComposerDraft("alpha", null)).toBe(fresh);
  expect(readComposerDraft("alpha", created.id)).toBe("");
  expect(JSON.parse(localStorage.getItem(RUN_PREFERENCES_STORAGE_KEY)!)[preference]).toEqual({ model: "provider/other", effort: "high", context1M: context });
  const next = thread("fresh-draft-created", "alpha", { runModel: "provider/other", runEffort: "high", runContext1M: context });
  vi.mocked(api.createThread).mockResolvedValue(next);
  vi.mocked(api.thread).mockImplementation(async (id) => ({ thread: id === next.id ? next : created, messages: [] }));
  await act(async () => { await store.createThread(); });
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Message" })).toHaveValue(fresh));
  expect(store.selectedThreadId).toBe(next.id);
  expect(api.createThread).toHaveBeenLastCalledWith("alpha", { model: "provider/other", effort: "high", context1M: context }, expect.any(AbortSignal), undefined);
  expect(readComposerDraft("alpha", null)).toBe("");
  expect(readComposerDraft("alpha", created.id)).toBe("");
  expect(readComposerDraft("alpha", next.id)).toBe(fresh);
  expect(api.transcribe).not.toHaveBeenCalled(); expect(api.submit).not.toHaveBeenCalled();
});
