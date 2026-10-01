import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agent } from "../../test/fixtures";
import { discardSettingsDraft, getSettingsDraft, setSettingsDraft } from "../../settings-drafts";
import type { AgentSummary } from "../../types";

const store = vi.hoisted(() => ({ selectedAgent: null as AgentSummary | null, activeThreads: null as { runningCounts: Record<string, number> } | null, catalogByProvider: {}, ensureProviderCatalog: vi.fn(), setAgentPinned: vi.fn(), setAgentRunDefaults: vi.fn(), clearAgentRunDefaults: vi.fn() }));
const mockApi = vi.hoisted(() => ({ latestAgentRestart: vi.fn(), providerAuthStatus: vi.fn(), providerUsage: vi.fn(), restartStatus: vi.fn(), requestAgentRestart: vi.fn() }));
vi.mock("../../console-store", () => ({ useConsoleStore: () => store }));
vi.mock("../../api", async (original) => ({ ...await original<typeof import("../../api")>(), api: mockApi }));
import { AgentSettingsScreen } from "./AgentSettingsScreen";

const props = { layout: "split" as const, onClose: vi.fn(), onNotice: vi.fn() };
beforeEach(() => {
  // Base UI emits a pointer event when a switch is activated; jsdom lacks PointerEvent.
  if (!window.PointerEvent) window.PointerEvent = MouseEvent as typeof PointerEvent;
  vi.clearAllMocks();
  store.activeThreads = null;
  store.selectedAgent = agent("fictional", { label: "Atlas", pinned: false, supportsProviderAuth: true });
  mockApi.latestAgentRestart.mockResolvedValue(null);
  mockApi.providerAuthStatus.mockResolvedValue({ schema: "mono-agent.provider-auth.v1", generatedAt: new Date().toISOString(), providers: [] });
  store.setAgentPinned.mockResolvedValue(undefined);
  store.setAgentRunDefaults.mockResolvedValue(undefined);
  store.clearAgentRunDefaults.mockResolvedValue(undefined);
});
afterEach(() => { discardSettingsDraft("fictional"); discardSettingsDraft("grove-fictional"); });

describe("agent settings screen", () => {
  it("shows every section and the independent Pin row in one main", async () => {
    mockApi.latestAgentRestart.mockReturnValue(new Promise(() => undefined));
    render(<AgentSettingsScreen {...props} section={null} />);
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.queryByRole("navigation", { name: "Agent settings sections" })).toBeNull();
    expect([...document.querySelectorAll(".settings-page-section h2")].map((node) => node.textContent)).toEqual(["New conversations", "Providers", "Restart", "About"]);
    expect(screen.getByRole("switch", { name: "Pin Atlas first" })).toBeVisible();
    await waitFor(() => expect(mockApi.providerAuthStatus).toHaveBeenCalledTimes(1));
  });
  it("lets Escape close the missing-agent screen on desktop and go Back on phone (R3)", () => {
    store.selectedAgent = null;
    const view = render(<AgentSettingsScreen {...props} section="agent" />);
    expect(screen.getByText("This agent is no longer available.")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledOnce();
    view.rerender(<AgentSettingsScreen {...props} section="agent" layout="stacked" />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });
  it("retains an agent-scoped draft across section switches and close, then discards only on demand", () => {
    setSettingsDraft("fictional", { model: "atlas/example", effort: "low" });
    const view = render(<AgentSettingsScreen {...props} section="agent" />);
    expect(screen.getByRole("button", { name: "Save for new conversations" })).toBeTruthy();
    view.unmount();
    expect(getSettingsDraft("fictional")).toEqual({ model: "atlas/example", effort: "low" });
    discardSettingsDraft("fictional");
    expect(getSettingsDraft("fictional")).toBeNull();
  });
  it("preserves each agent's draft across agent and generation switches without leaking between agents (A9)", () => {
    setSettingsDraft("fictional", { model: "atlas/other", effort: "low" });
    const view = render(<AgentSettingsScreen {...props} section="new-conversations" />);
    expect(screen.getByRole("button", { name: "Save for new conversations" })).toBeTruthy();
    store.selectedAgent = agent("grove-fictional", { label: "Grove" });
    view.rerender(<AgentSettingsScreen {...props} section="new-conversations" />);
    expect(screen.queryByRole("button", { name: "Save for new conversations" })).toBeNull();
    act(() => setSettingsDraft("grove-fictional", { model: "grove/fast", effort: "high" }));
    expect(screen.getByRole("button", { name: "Save for new conversations" })).toBeTruthy();
    store.selectedAgent = agent("fictional", { label: "Atlas", generation: "next" });
    view.rerender(<AgentSettingsScreen {...props} section="new-conversations" />);
    expect(getSettingsDraft("fictional")).toEqual({ model: "atlas/other", effort: "low" });
    expect(getSettingsDraft("grove-fictional")).toEqual({ model: "grove/fast", effort: "high" });
    expect(screen.getByRole("button", { name: "Save for new conversations" })).toBeTruthy();
  });
  it("pins through the Agent switch, keeps its name constant and reports the requested state while pending", async () => {
    let settle!: () => void;
    store.setAgentPinned.mockReturnValueOnce(new Promise<void>((resolve) => { settle = resolve; }));
    render(<AgentSettingsScreen {...props} section="agent" />);
    const toggle = screen.getByRole("switch", { name: "Pin Atlas first" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect(toggle).toHaveAttribute("aria-disabled", "true");
    expect(toggle).toHaveAttribute("aria-busy", "true");
    expect(store.setAgentPinned).toHaveBeenCalledWith("fictional", true);
    await act(async () => settle());
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });
  it("activates the pin exactly once when its row is clicked", async () => {
    render(<AgentSettingsScreen {...props} section="agent" />);
    fireEvent.click(screen.getByText("Pinned agents sort first on the agent strip."));
    await waitFor(() => expect(store.setAgentPinned).toHaveBeenCalledTimes(1));
  });
  it("saves an offline use-config draft without closing the screen", async () => {
    store.selectedAgent = agent("fictional", { label: "Atlas", status: "offline", runSettings: {
      config: { model: "atlas/example" }, override: { model: "grove/fast", effort: "low" },
      effective: { model: "grove/fast", modelSource: "override", effort: "low", effortSource: "override" },
    } });
    setSettingsDraft("fictional", { model: "", effort: "" });
    render(<AgentSettingsScreen {...props} section="new-conversations" />);
    fireEvent.click(screen.getByRole("button", { name: "Save for new conversations" }));
    await waitFor(() => expect(store.clearAgentRunDefaults).toHaveBeenCalledTimes(1));
    expect(props.onClose).not.toHaveBeenCalled();
    expect(props.onNotice).toHaveBeenCalledWith(expect.stringContaining("New conversations will start with"));
    expect(getSettingsDraft("fictional")).toBeNull();
  });
  it("does not show an offline agent's stale running count as current (A19)", () => {
    store.selectedAgent = agent("fictional", { label: "Atlas", status: "offline", restart: { supported: true } });
    store.activeThreads = { runningCounts: { fictional: 3 } };
    render(<AgentSettingsScreen {...props} section="agent" />);
    expect(screen.getByText("Running now").closest(".settings-agent-fact-row")).toHaveTextContent("—");
    expect(screen.queryByText("3 conversations")).toBeNull();
  });
  it("keeps restart read errors distinct from no history and retries the status read", async () => {
    mockApi.latestAgentRestart.mockRejectedValueOnce(new Error("read refused")).mockResolvedValue(null);
    render(<AgentSettingsScreen {...props} section="agent" />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mockApi.latestAgentRestart).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("No recent restart")).toBeTruthy();
  });
  it("shows resolved model and effort names while retaining raw config and override ids", () => {
    store.selectedAgent = agent("fictional", { label: "Atlas", defaultEffort: "medium", modelOptions: { "atlas/standard": { label: "Atlas Standard", reasoning: true, effortLevels: ["medium"] }, "grove/fast": { label: "Grove Fast", reasoning: true, effortLevels: ["low"] } },
      runSettings: { config: { model: "atlas/standard", effort: "medium" }, override: { model: "grove/fast", effort: "low" }, effective: { model: "grove/fast", effort: "low", modelSource: "override", effortSource: "override" } },
    });
    render(<AgentSettingsScreen {...props} section="new-conversations" />);
    expect(screen.getAllByText("Grove Fast · Low").length).toBeGreaterThan(0);
    expect(screen.getByText("Atlas Standard · Medium")).toBeTruthy();
    expect(screen.getByText("atlas/standard · medium")).toBeTruthy();
    expect(screen.getByText("grove/fast · low")).toBeTruthy();
    expect(screen.queryByText("provider/model · default")).toBeNull();
  });
  it("keeps failed saves editable, retries, then announces success and focuses the picker", async () => {
    store.selectedAgent = agent("fictional", { label: "Atlas", models: ["provider/model", "grove/fast"], modelOptions: { "grove/fast": { label: "Grove Fast", reasoning: true, effortLevels: ["low"] } } });
    store.setAgentRunDefaults.mockRejectedValueOnce(new Error("service unavailable")).mockResolvedValueOnce(undefined);
    setSettingsDraft("fictional", { model: "grove/fast", effort: "low" });
    render(<AgentSettingsScreen {...props} section="new-conversations" />);
    const save = screen.getByRole("button", { name: "Save for new conversations" });
    fireEvent.click(save);
    expect(await screen.findByText(/Couldn't save: service unavailable/)).toBeTruthy();
    expect(screen.getByRole("status")).toHaveTextContent("Saving failed. service unavailable");
    expect(getSettingsDraft("fictional")).toEqual({ model: "grove/fast", effort: "low" });
    fireEvent.click(save);
    await waitFor(() => expect(store.setAgentRunDefaults).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Model and reasoning effort" })));
    expect(props.onNotice).toHaveBeenCalledWith("New conversations will start with Grove Fast · Low.");
    expect(props.onClose).not.toHaveBeenCalled();
    expect(getSettingsDraft("fictional")).toBeNull();
  });
  it("does not steal focus from Providers after a deferred save resolves", async () => {
    let settle!: () => void;
    store.setAgentRunDefaults.mockReturnValueOnce(new Promise<void>((resolve) => { settle = resolve; }));
    setSettingsDraft("fictional", { model: "grove/fast", effort: "low" });
    render(<AgentSettingsScreen {...props} section="new-conversations" />);
    fireEvent.click(screen.getByRole("button", { name: "Save for new conversations" }));
    const providers = screen.getByRole("region", { name: "Providers" });
    providers.focus();
    await act(async () => settle());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.activeElement).toBe(providers);
    expect(getSettingsDraft("fictional")).toBeNull();
  });
  it("does not focus the next agent's picker when an old agent save completes", async () => {
    let settle!: () => void;
    store.setAgentRunDefaults.mockReturnValueOnce(new Promise<void>((resolve) => { settle = resolve; }));
    setSettingsDraft("fictional", { model: "grove/fast", effort: "low" });
    const view = render(<AgentSettingsScreen {...props} section="new-conversations" />);
    fireEvent.click(screen.getByRole("button", { name: "Save for new conversations" }));
    store.selectedAgent = agent("grove-fictional", { label: "Grove" });
    view.rerender(<AgentSettingsScreen {...props} section="new-conversations" />);
    const providers = screen.getByRole("region", { name: "Providers" });
    providers.focus();
    await act(async () => settle());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.activeElement).toBe(providers);
    expect(props.onNotice).not.toHaveBeenCalled();
  });
  it("clears a draft when a server update catches up to it without losing a newer draft", async () => {
    setSettingsDraft("fictional", { model: "grove/fast", effort: "low" });
    const view = render(<AgentSettingsScreen {...props} section="new-conversations" />);
    store.selectedAgent = agent("fictional", { label: "Atlas", runSettings: { config: { model: "provider/model" }, override: { model: "grove/fast", effort: "low" }, effective: { model: "grove/fast", modelSource: "override", effort: "low", effortSource: "override" } } });
    view.rerender(<AgentSettingsScreen {...props} section="new-conversations" />);
    await waitFor(() => expect(getSettingsDraft("fictional")).toBeNull());
    expect(screen.queryByRole("button", { name: "Save for new conversations" })).toBeNull();
  });
  it("shows provider read errors and keeps the restart error retry inline", async () => {
    mockApi.providerAuthStatus.mockRejectedValue(new Error("Example provider read failed"));
    mockApi.latestAgentRestart.mockRejectedValue(new Error("Example restart read failed"));
    render(<AgentSettingsScreen {...props} section="providers" />);
    expect(await screen.findByText("Example provider read failed")).toBeTruthy();
    expect(await screen.findByText("Couldn't read restart status")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
  it("reverts the pin on failure and never shows a pin control in the header", async () => {
    store.setAgentPinned.mockRejectedValueOnce(new Error("offline"));
    render(<AgentSettingsScreen {...props} section="agent" />);
    const toggle = screen.getByRole("switch", { name: "Pin Atlas first" });
    fireEvent.click(toggle);
    await waitFor(() => expect(store.setAgentPinned).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
    expect(document.querySelector(".settings-header [role=switch]")).toBeNull();
  });

});


it("self-heals a hidden context draft and never revives it while changing effort", async () => {
  setSettingsDraft("fictional", { model: "provider/other", effort: "high", context1M: true });
  render(<AgentSettingsScreen {...props} section="new-conversations" />);
  await waitFor(() => expect(getSettingsDraft("fictional")?.context1M).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Model and reasoning effort" }));
  expect(screen.queryByRole("radiogroup", { name: "Context window" })).toBeNull();
  fireEvent.click(await screen.findByRole("radio", { name: "Medium" }));
  expect(getSettingsDraft("fictional")?.context1M).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  fireEvent.click(screen.getByRole("button", { name: "Save for new conversations" }));
  await waitFor(() => expect(store.setAgentRunDefaults).toHaveBeenCalledExactlyOnceWith("provider/other", "medium"));
});
