import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { page, userEvent } from "@vitest/browser/context";
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
  return <div style={{ padding: 24 }}><p>Synthetic composer model selection</p><ModelSelector
    models={[{ id: "", name: "Default · GPT-6.1 Sol", efforts: [], supportsContext1M: true, context1M: false }]}
    value="" effort="" context1M={enabled} onContext1MChange={setEnabled} onValueChange={() => {}} onEffortChange={() => {}} open side="bottom" />
    <p>Fictional state only — no agent connected.</p></div>;
}
beforeEach(() => {
  vi.clearAllMocks();
  discardSettingsDraft("synthetic-1m");
  store.selectedAgent = agent("synthetic-1m", { defaultModel: ref, models: [ref], modelOptions: { [ref]: { supportsContext1M: true, context1M: false } },
    runSettings: { config: { model: ref, context1M: false }, override: null, effective: { model: ref, modelSource: "config", effortSource: "config", context1M: false, context1MSource: "config" } } });
  store.setAgentRunDefaults.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); discardSettingsDraft("synthetic-1m"); });
for (const width of [390, 1280]) describe(`1M selection at ${width}px`, () => {
  it("shows an eligible automatic row and supports keyboard true/false", async () => {
    await page.viewport(width, 820);
    render(<ComposerFixture />);
    const checkbox = await screen.findByRole("checkbox", { name: "1M context" });
    expect(checkbox).not.toBeChecked();
    await shot(`composer-${width}-unchecked`);
    checkbox.focus(); await userEvent.keyboard("[Space]");
    expect(checkbox).toBeChecked();
    await shot(`composer-${width}-checked`);
    await userEvent.keyboard("[Space]"); expect(checkbox).not.toBeChecked();
  });
  it("saves an explicit false new-conversation default and has no horizontal overflow", async () => {
    await page.viewport(width, 820);
    render(<div className="agent-settings-panel" style={{ padding: 20, maxWidth: 680 }}><h2>Synthetic New conversations</h2><NewConversationsSection agent={store.selectedAgent!} onNotice={() => {}} /></div>);
    await userEvent.click(screen.getByRole("button", { name: "Model and reasoning effort" }));
    const checkbox = await screen.findByRole("checkbox", { name: "1M context" });
    await shot(`new-conversations-${width}`);
    await userEvent.click(checkbox); await userEvent.click(checkbox);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await userEvent.click(screen.getByRole("button", { name: "Save for new conversations" }));
    await waitFor(() => expect(store.setAgentRunDefaults).toHaveBeenCalledWith(null, null, false));
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  });
});
