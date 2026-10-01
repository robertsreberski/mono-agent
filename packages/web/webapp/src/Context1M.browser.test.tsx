import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { commands, page, userEvent } from "@vitest/browser/context";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelSelector } from "./components/assistant-ui/ModelSelector";
import { NewConversationsSection } from "./components/agent-settings/NewConversationsSection";
import { agent } from "./test/fixtures";
import { discardSettingsDraft } from "./settings-drafts";
import type { AgentSummary } from "./types";
import "./styles.css";

const store = vi.hoisted(() => ({ selectedAgent: null as AgentSummary | null, catalogByProvider: {}, ensureProviderCatalog: vi.fn(), setAgentRunDefaults: vi.fn(), clearAgentRunDefaults: vi.fn() }));
vi.mock("./console-store", () => ({ useConsoleStore: () => store }));
const ref = "openai-codex:gpt-6.1-sol";
const shots = import.meta.env.VITE_CONTEXT_1M_SHOTS as string | undefined;
async function shot(name: string) { if (shots) await page.screenshot({ path: `${shots}/synthetic-${name}.png` }); }
function ComposerFixture() {
  const [enabled, setEnabled] = useState(false);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("low");
  const efforts = [{ id: "", name: "Default · Provider" }, { id: "low", name: "Low" }, { id: "medium", name: "Medium" }, { id: "high", name: "High" }];
  return <div style={{ padding: 24 }}><p>Synthetic composer model selection</p><ModelSelector
    models={[{ id: "", name: "Default · Synthetic GPT", efforts, supportsContext1M: true, context1M: false, standardContextWindow: 272_000 }, { id: "synthetic:standard", name: "Synthetic standard model", efforts }]}
    value={model} effort={effort} context1M={enabled} onContext1MChange={setEnabled} onValueChange={(next) => { setModel(next); if (next) setEnabled(false); }} onEffortChange={setEffort} open side="bottom" />
    <p>Fictional state only — no agent connected.</p></div>;
}
beforeEach(async () => {
  await commands.emulateColorScheme("light");
  await commands.emulateReducedMotion(null);
  vi.clearAllMocks();
  discardSettingsDraft("synthetic-1m");
  store.selectedAgent = agent("synthetic-1m", { defaultModel: ref, models: [ref], modelOptions: { [ref]: { supportsContext1M: true, context1M: false, contextWindow: 272_000 } },
    runSettings: { config: { model: ref, context1M: false }, override: null, effective: { model: ref, modelSource: "config", effortSource: "config", context1M: false, context1MSource: "config" } } });
  store.setAgentRunDefaults.mockResolvedValue(undefined);
});
afterEach(async () => { cleanup(); discardSettingsDraft("synthetic-1m"); await commands.emulateColorScheme(null); await commands.emulateReducedMotion(null); });
for (const width of [390, 1280]) describe(`1M selection at ${width}px`, () => {
  it("shows an eligible automatic row and supports keyboard true/false", async () => {
    await page.viewport(width, 820);
    render(<ComposerFixture />);
    const standard = await screen.findByRole("radio", { name: "272K" });
    const extended = screen.getByRole("radio", { name: "1M" });
    expect(standard).toBeChecked();
    await shot(`composer-${width}-unchecked`);
    standard.focus(); await userEvent.keyboard("{ArrowRight}");
    expect(extended).toBeChecked();
    await shot(`composer-${width}-checked`);
    await userEvent.keyboard("{ArrowLeft}"); expect(standard).toBeChecked();
    await userEvent.click(screen.getByText("Synthetic standard model"));
    expect(screen.queryByRole("radiogroup", { name: "Context window" })).toBeNull();
    const context = document.querySelector<HTMLElement>(".model-selector__context-window")!;
    await waitFor(() => expect(context.getBoundingClientRect().height).toBeLessThan(1));
    if (width === 390) await shot("composer-390-ineligible");
  });
  it("saves an explicit false new-conversation default and has no horizontal overflow", async () => {
    await page.viewport(width, 820);
    render(<div className="agent-settings-panel" style={{ padding: 20, maxWidth: 680 }}><h2>Synthetic New conversations</h2><NewConversationsSection agent={store.selectedAgent!} onNotice={() => {}} /></div>);
    await userEvent.click(screen.getByRole("button", { name: "Model and reasoning effort" }));
    const standard = await screen.findByRole("radio", { name: "272K" });
    await shot(`new-conversations-${width}`);
    await userEvent.click(standard);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await userEvent.click(screen.getByRole("button", { name: "Save for new conversations" }));
    await waitFor(() => expect(store.setAgentRunDefaults).toHaveBeenCalledWith(null, null, false));
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  });
  it("keeps context chips aligned in dark mode and respects reduced motion", async () => {
    await page.viewport(width, 820);
    await commands.emulateColorScheme("dark");
    await commands.emulateReducedMotion("reduce");
    render(<ComposerFixture />);
    const context = await screen.findByRole("radiogroup", { name: "Context window" });
    await userEvent.click(screen.getByRole("radio", { name: "1M" }));
    expect(screen.getByRole("radio", { name: "1M" })).toBeChecked();
    expect(parseFloat(getComputedStyle(document.querySelector(".model-selector__context-window")!).transitionDuration)).toBeLessThanOrEqual(0.001);
    const effort = screen.getByRole("radiogroup", { name: "Reasoning effort" });
    expect(Math.abs(context.getBoundingClientRect().left - effort.getBoundingClientRect().left)).toBeLessThan(1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    if (width === 1280) await shot("composer-1280-dark-1m");
  });
});
