import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agent } from "../../test/fixtures";
import { discardSettingsDraft, getSettingsDraft, setSettingsDraft } from "../../settings-drafts";
import type { AgentSummary } from "../../types";

const store = vi.hoisted(() => ({ selectedAgent: null as AgentSummary | null, activeThreads: null, catalogByProvider: {}, ensureProviderCatalog: vi.fn(), setAgentPinned: vi.fn(), setAgentRunDefaults: vi.fn(), clearAgentRunDefaults: vi.fn() }));
const mockApi = vi.hoisted(() => ({ latestAgentRestart: vi.fn(), providerAuthStatus: vi.fn(), providerUsage: vi.fn() }));
vi.mock("../../console-store", () => ({ useConsoleStore: () => store }));
vi.mock("../../api", async (original) => ({ ...await original<typeof import("../../api")>(), api: mockApi }));
import { AgentSettingsScreen } from "./AgentSettingsScreen";

const props = { layout: "split" as const, onSection: vi.fn(), onBack: vi.fn(), onClose: vi.fn(), onNotice: vi.fn() };
beforeEach(() => {
  // Base UI emits a pointer event when a switch is activated; jsdom lacks PointerEvent.
  if (!window.PointerEvent) window.PointerEvent = MouseEvent as typeof PointerEvent;
  vi.clearAllMocks();
  store.selectedAgent = agent("fictional", { label: "Atlas", pinned: false, supportsProviderAuth: true });
  mockApi.latestAgentRestart.mockResolvedValue(null);
  mockApi.providerAuthStatus.mockResolvedValue({ schema: "mono-agent.provider-auth.v1", generatedAt: new Date().toISOString(), providers: [] });
  store.setAgentPinned.mockResolvedValue(undefined);
  store.setAgentRunDefaults.mockResolvedValue(undefined);
  store.clearAgentRunDefaults.mockResolvedValue(undefined);
});
afterEach(() => discardSettingsDraft("fictional"));

describe("agent settings screen", () => {
  it("has a single settings main and a navigation-only rail with three sections", async () => {
    render(<AgentSettingsScreen {...props} section="new-conversations" />);
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getByRole("navigation", { name: "Agent settings sections" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Providers/ }));
    expect(props.onSection).toHaveBeenCalledWith("providers");
    await waitFor(() => expect(mockApi.providerAuthStatus).toHaveBeenCalledTimes(1));
  });
  it("retains an agent-scoped draft across section switches and close, then discards only on demand", () => {
    setSettingsDraft("fictional", { model: "atlas/example", effort: "low" });
    const view = render(<AgentSettingsScreen {...props} section="agent" />);
    expect(screen.getByText("Unsaved change")).toBeTruthy();
    view.unmount();
    expect(getSettingsDraft("fictional")).toEqual({ model: "atlas/example", effort: "low" });
    discardSettingsDraft("fictional");
    expect(getSettingsDraft("fictional")).toBeNull();
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
  it("keeps restart read errors distinct from no history and retries the status read", async () => {
    mockApi.latestAgentRestart.mockRejectedValueOnce(new Error("read refused")).mockResolvedValue(null);
    render(<AgentSettingsScreen {...props} section="agent" />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mockApi.latestAgentRestart).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("No recent restart")).toBeTruthy();
  });
});
