import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api";
import { capabilitySnapshot } from "../../test/capability-fixtures";
import { agent } from "../../test/fixtures";
import { CapabilityCard, CapabilitiesSection } from "./CapabilitiesSection";

afterEach(() => vi.restoreAllMocks());
describe("Capabilities section", () => {
  it("shows all readiness states and read-only memory choices without an apply action", async () => {
    vi.spyOn(api, "capabilitySetup").mockResolvedValue(capabilitySnapshot);
    render(<CapabilitiesSection agent={agent("garden", { supportsCapabilitySetup: true })} />);
    await screen.findByRole("heading", { name: "Memory" });
    expect(screen.getAllByRole("article")).toHaveLength(9);
    for (const state of ["Ready", "Waiting", "Disabled", "Needs attention"]) expect(screen.getAllByText(state).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByText("Details & manual setup")[0]!);
    fireEvent.change(screen.getByRole("combobox", { name: "Inspect memory tier (read-only)" }), { target: { value: "memory:journal" } });
    expect(screen.getByText(capabilitySnapshot.cards[0]!.variants![1]!.purpose)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /apply|enable|save/i })).toBeNull();
    expect(api.capabilitySetup).toHaveBeenCalledTimes(1);
  });
  it("keeps prose numbered and groups JSON and .env examples into code blocks", () => {
    const card = capabilitySnapshot.cards.find((item) => item.id === "channel:telegram")!;
    render(<CapabilityCard card={card} />);
    fireEvent.click(screen.getByText("Details & manual setup"));
    const json = screen.getByLabelText("JSON configuration example");
    const env = screen.getByLabelText(".env placeholders");
    expect(json.tagName).toBe("PRE"); expect(json.querySelector("code")).not.toBeNull();
    expect(JSON.parse(json.textContent!)).toHaveProperty("telegram.enabled", true);
    expect(env.querySelector("code")!.textContent).toBe("# Telegram bot token from @BotFather\nMONO_AGENT_TELEGRAM_BOT_TOKEN=");
    expect(document.querySelectorAll(".capability-steps > li")).toHaveLength(3);
    expect(env.closest("li")!.querySelector("p")!.textContent).toContain("owner-only .env");
  });
  it("derives a different concrete disabled next step from each catalog-owned block", async () => {
    vi.spyOn(api, "capabilitySetup").mockResolvedValue(capabilitySnapshot);
    render(<CapabilitiesSection agent={agent("garden", { supportsCapabilitySetup: true })} />);
    await screen.findByRole("heading", { name: "Memory" });
    const next: string[] = [];
    for (const card of capabilitySnapshot.cards.filter((item) => item.status === "disabled")) {
      const article = screen.getByRole("article", { name: card.title });
      const text = article.querySelector(".capability-next")!.textContent!;
      expect(text).toContain(`the ${card.ownedConfigPaths[0]} block`);
      next.push(text);
    }
    expect(new Set(next).size).toBe(next.length);
    expect(within(screen.getByRole("article", { name: "Slack" })).getByText(/Set the .env tokens and add the slack block/)).toBeTruthy();
    expect(screen.getByText("Explore optional features and manual setup steps without changing your agent.")).toBeTruthy();
    expect(screen.queryByText(/durable configuration inputs|loaded runtime/)).toBeNull();
  });
  it("does not request status from offline or older agents", () => {
    const read = vi.spyOn(api, "capabilitySetup");
    const view = render(<CapabilitiesSection agent={agent("old")} />);
    expect(screen.getByText(/doesn't report capabilities/)).toBeTruthy();
    view.rerender(<CapabilitiesSection agent={agent("old", { status: "offline", supportsCapabilitySetup: true })} />);
    expect(screen.getByText(/no readiness is assumed/)).toBeTruthy();
    expect(read).not.toHaveBeenCalled();
  });
  it("discards old source and generation reads and exposes transport failures separately", async () => {
    let release!: (value: typeof capabilitySnapshot) => void;
    vi.spyOn(api, "capabilitySetup").mockImplementationOnce(() => new Promise((resolve) => { release = resolve; })).mockRejectedValue(new Error("private detail"));
    const view = render(<CapabilitiesSection agent={agent("one", { supportsCapabilitySetup: true, generation: "a" })} />);
    view.rerender(<CapabilitiesSection agent={agent("two", { supportsCapabilitySetup: true, generation: "b" })} />);
    await screen.findByRole("button", { name: "Retry capability status" });
    await act(async () => release(capabilitySnapshot));
    expect(screen.queryByRole("article")).toBeNull();
    expect(screen.queryByText("private detail")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry capability status" }));
    await waitFor(() => expect(api.capabilitySetup).toHaveBeenCalledTimes(3));
  });
});
