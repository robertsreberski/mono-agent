import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { page, userEvent } from "@vitest/browser/context";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { ConsoleStoreProvider, SELECTED_AGENT_STORAGE_KEY, useConsoleStore } from "./console-store";
import { WebRuntimeProvider } from "./runtime";
import { Chat } from "./components/Chat";
import { agent, bootstrap, thread } from "./test/fixtures";
import { installVoiceFixture } from "./test/voice-fixtures";
import { createThreadPersistence } from "./thread-persistence";
import type { ThreadSummary } from "./types";
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
  readyState = 1; onopen = null; onmessage = null; onerror = null;
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
      <h1 style={{ fontSize: 16, margin: 8 }}>Synthetic full console voice fixture</h1>
      {import.meta.env.VITE_VOICE_REVISION && <p style={{ fontSize: 10, margin: "0 8px 4px" }}>Fixture revision: {import.meta.env.VITE_VOICE_REVISION}</p>}
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
  localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, "", "/");
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
afterEach(async () => { cleanup(); fixture.restore(); await persistence.clearAll(); localStorage.clear(); });
async function record() {
  await waitFor(() => expect(screen.getByRole("button", { name: "Record voice message" })).toBeEnabled());
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
    const oldInput = screen.getByRole("combobox", { name: "Message" });
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
    expect(screen.getByRole("button", { name: "Record voice message" })).toBeEnabled();
    expect(screen.queryByText("Transcribing…")).not.toBeInTheDocument();
    expect(fixture.stop).toHaveBeenCalledTimes(2);
    // Cancellation/UI recovery must happen BEFORE the old acknowledgement.
    await act(async () => { if (outcome === "resolve") resolveCreate(created); else rejectCreate(new Error("Synthetic create refusal")); });
    expect(store.selectedThreadId).toBe(destination.id);
    expect(screen.getByRole("combobox", { name: "Message" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Record voice message" })).toBeEnabled();
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
