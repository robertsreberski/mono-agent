import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { commands, page, userEvent } from "@vitest/browser/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { CapabilitiesSection } from "./components/agent-settings/CapabilitiesSection";
import { capabilitySnapshot } from "./test/capability-fixtures";
import { agent } from "./test/fixtures";
import "./styles.css";

const shots = import.meta.env.VITE_CAPABILITY_SHOTS as string | undefined;
beforeEach(async () => {
  await commands.emulateColorScheme("light");
  vi.spyOn(api, "capabilitySetup").mockResolvedValue(capabilitySnapshot);
});
afterEach(async () => { cleanup(); vi.restoreAllMocks(); await commands.emulateColorScheme(null); });
function Preview({ older = false }: { readonly older?: boolean }) {
  return <div style={{ height: "100dvh", overflow: "auto" }}><main style={{ maxWidth: 860, margin: "0 auto", padding: 20 }}>
    <span className="eyebrow">Fictional Garden Agent · Agent settings</span><h1>Capabilities</h1>
    <p>Synthetic display data — no agent connected. Read-only guidance.</p>
    <CapabilitiesSection agent={agent("garden", older ? {} : { supportsCapabilitySetup: true })} />
  </main></div>;
}
for (const width of [390, 1440]) describe(`Capabilities at ${width}px`, () => {
  it("shows mixed statuses, keyboard-accessible manual instructions, and no horizontal overflow", async () => {
    await page.viewport(width, 1900);
    render(<Preview />);
    await screen.findByRole("heading", { name: "MCP / tools" });
    for (const status of ["Ready", "Waiting", "Disabled", "Needs attention"]) expect(screen.getAllByText(status).length).toBeGreaterThan(0);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    if (shots) await page.screenshot({ path: `${shots}/capabilities-synthetic-${width}-mixed.png` });
    const select = screen.getByRole("combobox", { name: "Inspect memory tier (read-only)" });
    select.focus(); await userEvent.keyboard("j{Enter}");
    // Native select behavior varies between WebKit and Chromium: selecting via the
    // browser's semantic API still exercises the real control without mouse offsets.
    await userEvent.selectOptions(select, "memory:journal");
    expect(screen.getByText("Synthetic journal memory guidance.")).toBeVisible();
    const details = screen.getAllByText("How to enable / next steps")[0]!;
    details.focus(); await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByText("Inspect the journal recipe in the owner terminal.")).toBeVisible());
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  });
  it("shows unsupported older-agent state rather than fabricated statuses", async () => {
    await page.viewport(width, 900);
    render(<Preview older />);
    expect(screen.getByText(/doesn't report capabilities/)).toBeVisible();
    expect(screen.queryByRole("article")).toBeNull();
    if (shots) await page.screenshot({ path: `${shots}/capabilities-synthetic-${width}-older-agent.png` });
  });
});
