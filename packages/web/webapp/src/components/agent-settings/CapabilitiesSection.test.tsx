import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../../api";
import type { CapabilityRestartState } from "./CapabilityActionControls";
import { capabilitySnapshot, capabilityActions, eligibleCronSnapshot, eligibleCronActions } from "../../test/capability-fixtures";
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
    expect(screen.getByText(/Explore optional features\. Eligible Memory Lite/)).toBeTruthy();
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
  it("shows a connection-specific degraded notice instead of claiming an update is needed", () => {
    const read = vi.spyOn(api, "capabilitySetup");
    render(<CapabilitiesSection agent={agent("garden", { status: "degraded" })} />);
    expect(screen.getByText(/connection is degraded/)).toBeTruthy();
    expect(screen.queryByText(/Update the agent/)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
  it("retains the current report and expanded instructions during refresh and refresh failure", async () => {
    let reject!: (reason: Error) => void;
    vi.spyOn(api, "capabilitySetup").mockResolvedValueOnce(capabilitySnapshot)
      .mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }))
      .mockImplementationOnce(() => new Promise(() => {}));
    const view = render(<CapabilitiesSection agent={agent("garden", { supportsCapabilitySetup: true, generation: "one" })} />);
    await screen.findByRole("heading", { name: "Memory" });
    const article = screen.getByRole("article", { name: "Memory" });
    const details = article.querySelector("details")!;
    fireEvent.click(within(article).getByText("Details & manual setup"));
    expect(details.open).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Refresh capability status" }));
    expect(screen.getAllByRole("article")).toHaveLength(9);
    expect(screen.getByRole("article", { name: "Memory" })).toBe(article);
    expect(details.open).toBe(true);
    await act(async () => reject(new Error("Synthetic failure")));
    expect(screen.getByText(/Showing the last report below, not a fresh check/)).toBeTruthy();
    expect(screen.getAllByRole("article")).toHaveLength(9);
    view.rerender(<CapabilitiesSection agent={agent("garden", { supportsCapabilitySetup: true, generation: "two" })} />);
    expect(screen.queryByRole("article")).toBeNull();
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

it("does not mistake a delayed pre-save restart baseline for a new restart", async () => {
  vi.spyOn(api, "capabilitySetup").mockResolvedValue(eligibleCronSnapshot);
  vi.spyOn(api, "capabilityActions").mockResolvedValue(eligibleCronActions);
  vi.spyOn(api, "previewCapabilityAction").mockResolvedValue({ action: "cron-controls", process: capabilityActions.process, expectedVersion: "a".repeat(64), changes: [], normalizesFormatting: true, noOp: false });
  vi.spyOn(api, "saveCapabilityAction").mockImplementation(async () => {
    vi.mocked(api.capabilityActions).mockResolvedValue({ ...eligibleCronActions, actions: eligibleCronActions.actions.map((action) => action.id === "cron-controls" ? { ...action, reason: "already-configured" as const } : action) });
    return { action: "cron-controls", process: capabilityActions.process, version: "b".repeat(64), changed: true };
  });
  const selected = agent("garden", { supportsCapabilitySetup: true, supportsCapabilityActions: true, restart: { supported: true } });
  const view = render(<CapabilitiesSection agent={selected} restart={{ readState: "loading" } as CapabilityRestartState} />);
  fireEvent.click(await screen.findByRole("button", { name: "Enable cron controls…" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm Save" }));
  await screen.findByText("Saved; applies on next start");
  expect(screen.getByRole("button", { name: "Restart to apply…" })).toBeDisabled();
  view.rerender(<CapabilitiesSection agent={selected} restart={{ readState: "ready", operationId: "older-operation", outcome: "success" } as CapabilityRestartState} />);
  expect(screen.queryByText(/Back online\. Refresh capability status/)).toBeNull();
  expect(screen.getByText("Saved; applies on next start")).toBeVisible();
});

it("keeps the generated default actions consistent with the paired snapshot cards", () => {
  expect(capabilityActions.process).toEqual(capabilitySnapshot.process);
  expect(capabilitySnapshot.cards.find((card) => card.id === "memory")).toMatchObject({ status: "ok", selectedVariant: "memory:lite" });
  expect(capabilityActions.actions.find((action) => action.id === "memory-lite")).toMatchObject({ active: true, reason: "already-configured" });
  expect(capabilitySnapshot.cards.find((card) => card.id === "channel:cron")).toMatchObject({ status: "disabled" });
  expect(capabilityActions.actions.find((action) => action.id === "cron-controls")).toMatchObject({ active: false, available: false, reason: "no-valid-jobs" });
});
it("uses Enable-aware next steps without changing validation status", async () => {
  vi.spyOn(api, "capabilitySetup").mockResolvedValue({ ...eligibleCronSnapshot, cards: eligibleCronSnapshot.cards.map((card) => card.id === "channel:cron" ? { ...card, status: "disabled" } : card) });
  vi.spyOn(api, "capabilityActions").mockResolvedValue(eligibleCronActions);
  render(<CapabilitiesSection agent={agent("garden", { supportsCapabilitySetup: true, supportsCapabilityActions: true })} />);
  const button = await screen.findByRole("button", { name: "Enable cron controls…" });
  const card = button.closest("article")!;
  expect(card.querySelector(".capability-next")!.textContent).toContain("Review and Save below");
  expect(card.querySelector(".capability-next")!.textContent).not.toContain("Add the cron block");
  expect(within(card).getByText("Disabled")).toBeVisible();
});

it("shows loaded-at-start evidence once on an active Memory card", async () => {
  vi.spyOn(api, "capabilitySetup").mockResolvedValue(capabilitySnapshot);
  vi.spyOn(api, "capabilityActions").mockResolvedValue(capabilityActions);
  render(<CapabilitiesSection agent={agent("garden", { supportsCapabilitySetup: true, supportsCapabilityActions: true })} />);
  await screen.findByText("Active");
  const memory = screen.getByRole("article", { name: "Memory" });
  expect(within(memory).getAllByText(/Loaded at this start/)).toHaveLength(1);
  expect(memory.querySelector(".capability-next")!.textContent).toBe("Next: Inspect readiness evidence below.");
});

it("removes stale Enable controls when refreshing availability fails", async () => {
  vi.spyOn(api, "capabilitySetup").mockResolvedValue(eligibleCronSnapshot);
  vi.spyOn(api, "capabilityActions").mockResolvedValueOnce(eligibleCronActions).mockRejectedValue(new Error("Fictional unavailable response"));
  render(<CapabilitiesSection agent={agent("garden", { supportsCapabilitySetup: true, supportsCapabilityActions: true })} />);
  await screen.findByRole("button", { name: "Enable cron controls…" });
  fireEvent.click(screen.getByRole("button", { name: "Refresh capability status" }));
  await screen.findByText(/Enable availability could not be verified/);
  expect(screen.queryByRole("button", { name: "Enable cron controls…" })).toBeNull();
});
it.each(["env-shadowed", "no-valid-jobs", "eligible"] as const)("reconciles a confirmed Save with fresh %s eligibility", async (reason) => {
  vi.spyOn(api, "capabilitySetup").mockResolvedValue(eligibleCronSnapshot);
  vi.spyOn(api, "capabilityActions").mockResolvedValue(eligibleCronActions);
  vi.spyOn(api, "previewCapabilityAction").mockResolvedValue({ action: "cron-controls", process: capabilityActions.process, expectedVersion: "a".repeat(64), changes: [], normalizesFormatting: true, noOp: false });
  vi.spyOn(api, "saveCapabilityAction").mockImplementation(async () => {
    vi.mocked(api.capabilityActions).mockResolvedValue({ ...eligibleCronActions, actions: eligibleCronActions.actions.map((action) => action.id === "cron-controls" ? { ...action, reason: "already-configured" as const } : action) });
    return { action: "cron-controls", process: capabilityActions.process, version: "b".repeat(64), changed: true };
  });
  render(<CapabilitiesSection agent={agent("garden", { supportsCapabilitySetup: true, supportsCapabilityActions: true, restart: { supported: true } })} restart={{ readState: "ready" } as CapabilityRestartState} />);
  fireEvent.click(await screen.findByRole("button", { name: "Enable cron controls…" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm Save" }));
  await screen.findByRole("button", { name: "Restart to apply…" });
  vi.mocked(api.capabilityActions).mockResolvedValue({ ...eligibleCronActions, actions: eligibleCronActions.actions.map((action) => action.id === "cron-controls" ? { ...action, reason, available: reason === "eligible" } : action) });
  fireEvent.click(screen.getByRole("button", { name: "Refresh capability status" }));
  await waitFor(() => expect(screen.queryByText("Saved; applies on next start")).toBeNull());
  await waitFor(() => expect(api.capabilityActions).toHaveBeenCalledTimes(3));
  expect(screen.queryByRole("button", { name: "Restart to apply…" })).toBeNull();
  if (reason === "eligible") await screen.findByRole("button", { name: "Enable cron controls…" });
  else await screen.findByText(reason === "env-shadowed" ? /Resolve it in the owner terminal/ : /Prepare valid cron jobs first/);
});
it.each(["resolved", "rejected"])("retains a %s stale Save even when generation remounts controls and availability fails", async (outcome) => {
  vi.spyOn(api, "capabilitySetup").mockResolvedValue(eligibleCronSnapshot);
  vi.spyOn(api, "capabilityActions").mockResolvedValueOnce(eligibleCronActions).mockRejectedValue(new Error("Fictional unavailable response"));
  vi.spyOn(api, "previewCapabilityAction").mockResolvedValue({ action: "cron-controls", process: capabilityActions.process, expectedVersion: "a".repeat(64), changes: [], normalizesFormatting: true, noOp: false });
  let finish!: () => void;
  vi.spyOn(api, "saveCapabilityAction").mockImplementation(() => new Promise((resolve, reject) => {
    finish = () => outcome === "resolved" ? resolve({ action: "cron-controls", process: capabilityActions.process, version: "b".repeat(64), changed: true }) : reject(new ApiError("Fictional stale response", 409, "capability_action_conflict"));
  }));
  const selected = agent("garden", { generation: "old", supportsCapabilitySetup: true, supportsCapabilityActions: true });
  const view = render(<CapabilitiesSection agent={selected} />);
  fireEvent.click(await screen.findByRole("button", { name: "Enable cron controls…" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm Save" }));
  view.rerender(<CapabilitiesSection agent={{ ...selected, generation: "new" }} />);
  await screen.findByText(/Enable availability could not be verified/);
  await act(async () => finish());
  expect(await screen.findByRole("alert")).toHaveTextContent("A save may have completed; inspect the configuration before retrying");
  expect(screen.queryByRole("button", { name: "Enable cron controls…" })).toBeNull();
});
it("resets the inspected Memory tier for a new generation without resetting parent action state", async () => {
  vi.spyOn(api, "capabilitySetup").mockResolvedValue(capabilitySnapshot);
  const selected = agent("garden", { generation: "old", supportsCapabilitySetup: true });
  const view = render(<CapabilitiesSection agent={selected} />);
  fireEvent.change(await screen.findByLabelText("Inspect memory tier (read-only)"), { target: { value: "memory:journal" } });
  view.rerender(<CapabilitiesSection agent={{ ...selected, generation: "new" }} />);
  expect(await screen.findByLabelText("Inspect memory tier (read-only)")).toHaveValue(capabilitySnapshot.cards[0]!.selectedVariant);
});
