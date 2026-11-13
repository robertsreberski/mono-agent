import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { commands, page, userEvent } from "@vitest/browser/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantRuntimeProvider, useLocalRuntime } from "@assistant-ui/react";
import { api } from "./api";
import { AgentSettingsScreen } from "./components/agent-settings/AgentSettingsScreen";
import { Dashboard } from "./components/dashboard/Dashboard";
import { NotificationsProvider } from "./notifications";
import { capabilitySnapshot } from "./test/capability-fixtures";
import { agent } from "./test/fixtures";
import { capabilityConsoleStore as storyStore } from "./test/capability-console-store";
import "./styles.css";

vi.mock("./console-store", async () => import("./test/capability-console-store"));
const shots = import.meta.env.VITE_CAPABILITY_SHOTS as string | undefined;
const initialStore = { ...storyStore };
beforeEach(async () => {
  await commands.emulateColorScheme("light");
  vi.spyOn(api, "capabilitySetup").mockResolvedValue(capabilitySnapshot);
  vi.spyOn(api, "latestAgentRestart").mockResolvedValue(null);
});
afterEach(async () => { cleanup(); Object.assign(storyStore, initialStore); vi.restoreAllMocks(); await commands.emulateColorScheme(null); });
function Preview({ width, older = false }: { readonly width: number; readonly older?: boolean }) {
  const runtime = useLocalRuntime({ async *run() { yield { content: [{ type: "text", text: "Synthetic preview only" }] }; } });
  const selected = agent("garden", { label: "Garden Agent · synthetic", ...(older ? {} : { supportsCapabilitySetup: true }) });
  Object.assign(storyStore, { selectedAgent: selected, selectedAgentId: selected.sourceId, agents: [selected], visibleAgents: [selected], selectedThread: null, selectedThreadId: null });
  // Same shell, actual Dashboard navigation, header, scrollport and settings
  // screen as the console. Only store/API display data are synthetic.
  return <AssistantRuntimeProvider runtime={runtime}><NotificationsProvider><div className="app-shell is-settings-open">
    <div className="dashboard-panel" aria-hidden={width <= 900 || undefined} inert={width <= 900}><Dashboard /></div>
    <div className="chat-region" aria-hidden="true" inert />
    <div className="settings-region"><AgentSettingsScreen section="capabilities" layout={width <= 900 ? "stacked" : "split"} onClose={() => undefined} onNotice={() => undefined} /></div>
  </div></NotificationsProvider></AssistantRuntimeProvider>;
}
async function settleAndReveal(width: number) {
  const surface = document.querySelector<HTMLElement>(".settings-region")!;
  await waitFor(() => {
    if (width === 390) {
      expect(surface.getBoundingClientRect().left).toBeCloseTo(0, 0);
      expect(surface.getBoundingClientRect().width).toBe(width);
    }
  });
  const target = document.querySelector<HTMLElement>('[data-settings-target="capabilities"]')!;
  target.scrollIntoView({ block: "start" });
  await waitFor(() => expect(target.getBoundingClientRect().top).toBeLessThan(window.innerHeight - 160));
}
for (const width of [390, 1440]) describe(`Capabilities in console settings at ${width}px`, () => {
  it("shows a compact mixed-status overview and real catalog setup, without horizontal overflow", async () => {
    await page.viewport(width, width === 390 ? 1900 : 1100);
    render(<Preview width={width} />);
    await screen.findByRole("heading", { name: "MCP / tools" });
    for (const heading of screen.getAllByRole("heading", { name: "Garden Agent · synthetic", level: 1 })) expect(heading).toBeVisible();
    expect(screen.getByRole("button", { name: width === 390 ? "Back from agent settings" : "Close agent settings" })).toBeVisible();
    for (const status of ["Ready", "Waiting", "Disabled", "Needs attention"]) expect(screen.getAllByText(status, { exact: false }).length).toBeGreaterThan(0);
    await settleAndReveal(width);
    expect(screen.getAllByRole("article")).toHaveLength(9);
    const cards = screen.getAllByRole("article");
    await waitFor(() => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width));
    for (const card of cards) expect(card.getBoundingClientRect().right).toBeLessThanOrEqual(width);
    const first = cards[0]!.getBoundingClientRect(); const second = cards[1]!.getBoundingClientRect();
    if (width === 1440) expect(second.left).toBeGreaterThan(first.left);
    else expect(second.left).toBe(first.left);
    expect(cards.every((card) => !card.querySelector("details")!.open)).toBe(true);
    expect(getComputedStyle(cards[0]!.querySelector(".capability-purpose")!).webkitLineClamp).toBe("2");
    if (shots) await page.screenshot({ path: `${shots}/capabilities-synthetic-${width}-mixed.png` });

    const telegram = screen.getByRole("article", { name: "Telegram" });
    await userEvent.click(within(telegram).getByText("Details & manual setup"));
    telegram.scrollIntoView({ block: "start" });
    expect(within(telegram).getByRole("heading", { name: "How to enable / next steps" })).toBeVisible();
    expect(within(telegram).getByText(capabilitySnapshot.cards.find((card) => card.id === "channel:telegram")!.requirements[0]!)).toBeVisible();
    expect(within(telegram).getByText(/MONO_AGENT_TELEGRAM_BOT_TOKEN=/)).toBeVisible();
    const json = within(telegram).getByLabelText("JSON configuration example");
    const env = within(telegram).getByLabelText(".env placeholders");
    expect(getComputedStyle(json).fontFamily).toContain("mono");
    expect(env.querySelector("code")!.textContent).toContain("# Telegram bot token from @BotFather\nMONO_AGENT_TELEGRAM_BOT_TOKEN=");
    expect(telegram.querySelectorAll(".capability-steps > li")).toHaveLength(3);
    if (shots) {
      await page.viewport(width, width === 390 ? 1900 : 1600);
      await page.screenshot({ path: `${shots}/capabilities-synthetic-${width}-expanded.png` });
    }
    await userEvent.click(within(telegram).getByText("Details & manual setup"));

    const memory = screen.getByRole("article", { name: "Memory" });
    const details = within(memory).getByText("Details & manual setup");
    details.focus(); await userEvent.keyboard("{Enter}");
    const select = within(memory).getByRole("combobox", { name: "Inspect memory tier (read-only)" });
    select.focus(); await userEvent.selectOptions(select, "memory:journal");
    expect(within(memory).getByText(capabilitySnapshot.cards[0]!.variants![1]!.purpose)).toBeVisible();
    expect(within(memory).getByText(/Embedding\/model liveness is not probed here/)).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  });
  it("shows the older-agent unsupported state inside the console layout", async () => {
    await page.viewport(width, 600);
    render(<Preview width={width} older />);
    await settleAndReveal(width);
    expect(screen.getByText(/doesn't report capabilities/)).toBeVisible();
    expect(screen.queryByRole("article")).toBeNull();
    for (const heading of screen.getAllByRole("heading", { name: "Garden Agent · synthetic", level: 1 })) expect(heading).toBeVisible();
    if (shots) await page.screenshot({ path: `${shots}/capabilities-synthetic-${width}-older-agent.png` });
  });
});
