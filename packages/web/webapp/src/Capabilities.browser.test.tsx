import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { commands, page, userEvent } from "@vitest/browser/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantRuntimeProvider, useLocalRuntime } from "@assistant-ui/react";
import { api, ApiError } from "./api";
import { AgentSettingsScreen } from "./components/agent-settings/AgentSettingsScreen";
import { Dashboard } from "./components/dashboard/Dashboard";
import { NotificationsProvider } from "./notifications";
import { capabilitySnapshot, capabilityActions, eligibleCronSnapshot, eligibleCronActions } from "./test/capability-fixtures";
import { agent } from "./test/fixtures";
import { capabilityConsoleStore as storyStore } from "./test/capability-console-store";
import "./styles.css";

vi.mock("./console-store", async () => import("./test/capability-console-store"));
declare module "@vitest/browser/context" {
  interface BrowserCommands { prepareCapabilityScreenshots(): Promise<void>; }
}
const shots = import.meta.env.VITE_CAPABILITY_SHOTS as string | undefined;
const initialStore = { ...storyStore };
beforeEach(async () => {
  await commands.prepareCapabilityScreenshots();
  await commands.emulateColorScheme("light");
  vi.spyOn(api, "capabilitySetup").mockResolvedValue(capabilitySnapshot);
  vi.spyOn(api, "capabilityActions").mockResolvedValue(capabilityActions);
  vi.spyOn(api, "latestAgentRestart").mockResolvedValue(null);
});
afterEach(async () => { cleanup(); Object.assign(storyStore, initialStore); vi.restoreAllMocks(); await commands.emulateColorScheme(null); });
function Preview({ width, older = false, degraded = false, managed = false, credentials = false }: { readonly credentials?: boolean; readonly width: number; readonly older?: boolean; readonly degraded?: boolean; readonly managed?: boolean }) {
  const runtime = useLocalRuntime({ async *run() { yield { content: [{ type: "text", text: "Synthetic preview only" }] }; } });
  const selected = agent("garden", { label: "Garden Agent · synthetic", status: degraded ? "degraded" : "online", restart: { supported: managed }, ...(older ? {} : { supportsCapabilitySetup: true, supportsCapabilityActions: true, ...(credentials ? { supportsCredentialSetup: true } : {}) }) });
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
    // The catalog grid plus the standalone Subagents delegation card (the
    // synthetic snapshot reports subagents unconfigured, so it stays a refusal).
    expect(screen.getAllByRole("article")).toHaveLength(capabilitySnapshot.cards.length + 1);
    expect(screen.getByRole("article", { name: "Subagents" })).toBeVisible();
    const cards = within(document.querySelector(".capability-grid")!).getAllByRole("article");
    expect(cards).toHaveLength(capabilitySnapshot.cards.length);
    const activeMemory = screen.getByRole("article", { name: "Memory" });
    expect(within(activeMemory).getAllByText(/Loaded at this start/)).toHaveLength(1);
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
  it("distinguishes a degraded connection from a known older agent", async () => {
    await page.viewport(width, 600);
    render(<Preview width={width} degraded />);
    await settleAndReveal(width);
    expect(screen.getByText(/connection is degraded/)).toBeVisible();
    expect(screen.queryByText(/Update the agent/)).toBeNull();
    expect(api.capabilitySetup).not.toHaveBeenCalled();
  });
  it("shows the older-agent unsupported state inside the console layout", async () => {
    await page.viewport(width, 600);
    render(<Preview width={width} older />);
    await settleAndReveal(width);
    expect(screen.getByText(/doesn't report capabilities/)).toBeVisible();
    expect(screen.queryByRole("article")).toBeNull();
    expect(api.capabilitySetup).not.toHaveBeenCalled();
    for (const heading of screen.getAllByRole("heading", { name: "Garden Agent · synthetic", level: 1 })) expect(heading).toBeVisible();
    if (shots) await page.screenshot({ path: `${shots}/capabilities-synthetic-${width}-older-agent.png` });
  });
});

for (const managed of [false, true]) it(`confirms/cancels typed saves and shows ${managed ? "managed restart" : "foreground pending"} truth`, async () => {
  await page.viewport(1440, 1100);
  vi.mocked(api.capabilitySetup).mockResolvedValue(eligibleCronSnapshot);
  vi.mocked(api.capabilityActions).mockResolvedValue(eligibleCronActions);
  const preview = { action: "cron-controls" as const, process: capabilityActions.process, expectedVersion: "a".repeat(64), changes: [{ field: "cron.operatorActions.enabled" as const, value: "true" }], normalizesFormatting: true as const, exactBytes: false as const, noOp: false };
  vi.spyOn(api, "previewCapabilityAction").mockImplementation(async (sourceId, input) => { expect(sourceId).toBe("garden"); expect(input).toEqual({ action: preview.action, process: preview.process }); return preview; });
  const save = vi.spyOn(api, "saveCapabilityAction").mockImplementation(async () => {
    vi.mocked(api.capabilityActions).mockResolvedValue({ ...eligibleCronActions, actions: eligibleCronActions.actions.map((action) => action.id === "cron-controls" ? { ...action, reason: "already-configured" as const } : action) });
    return { action: preview.action, process: preview.process, version: "b".repeat(64), changed: true };
  });
  const operation = { id: "synthetic-restart", sourceId: "garden", stage: "restarting" as const, requestedAt: "2026-08-01T10:00:00Z", deadline: "2026-08-01T10:02:00Z" };
  const request = vi.spyOn(api, "requestAgentRestart").mockResolvedValue(operation);
  vi.spyOn(api, "restartStatus").mockResolvedValue(operation);
  render(<Preview width={1440} managed={managed} />);
  const enable = await screen.findByRole("button", { name: "Enable cron controls…" });
  await userEvent.click(enable);
  expect(screen.getByLabelText("Owned-field preview").textContent).toBe("true");
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(save).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  await userEvent.click(enable); await userEvent.click(screen.getByRole("button", { name: "Confirm Save" }));
  await screen.findByText("Saved; applies on next start");
  expect(save).toHaveBeenCalledWith("garden", { action: "cron-controls", process: preview.process, expectedVersion: preview.expectedVersion, confirmed: true });
  expect(request).not.toHaveBeenCalled();
  if (managed) {
    await userEvent.click(screen.getByRole("button", { name: "Restart to apply…" }));
    expect(screen.getByText(/Restarting may interrupt active conversations/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Confirm restart" }));
    await screen.findByText("Saved; restarting…"); expect(request).toHaveBeenCalledTimes(1);
    vi.mocked(api.restartStatus).mockResolvedValue({ ...operation, stage: "back_online", outcome: "success" });
    await screen.findByText(/Back online\. Refresh capability status/, {}, { timeout: 5000 });
    // A fresh generation plus agent-owned loaded-state evidence, not a saved DTO, proves activation.
    vi.mocked(api.capabilityActions).mockResolvedValue({ ...capabilityActions, process: { ...preview.process, startedAt: "2026-08-01T10:01:00Z" }, actions: eligibleCronActions.actions.map((action) => action.id === "cron-controls" ? { ...action, active: true, reason: "already-configured" as const } : action) });
    await userEvent.click(screen.getByRole("button", { name: "Refresh capability status" }));
    await waitFor(() => expect(screen.queryByText("Saved; restarting…")).toBeNull());
    const cron = screen.getByRole("article", { name: "Scheduled jobs (cron)" });
    expect(within(cron).getByText("Active")).toBeVisible();
  } else expect(screen.queryByRole("button", { name: "Restart to apply…" })).toBeNull();
});
it("refreshes on conflicts and requires another explicit preview instead of retrying a save", async () => {
  await page.viewport(390, 1000);
  vi.mocked(api.capabilitySetup).mockResolvedValue(eligibleCronSnapshot);
  vi.mocked(api.capabilityActions).mockResolvedValue(eligibleCronActions);
  vi.spyOn(api, "previewCapabilityAction").mockResolvedValue({ action: "cron-controls", process: capabilityActions.process, expectedVersion: "a".repeat(64), changes: [], normalizesFormatting: true, exactBytes: false, noOp: false });
  const save = vi.spyOn(api, "saveCapabilityAction").mockRejectedValue(new ApiError("conflict", 409, "capability_action_conflict"));
  render(<Preview width={390} />);
  await userEvent.click(await screen.findByRole("button", { name: "Enable cron controls…" }));
  await userEvent.click(screen.getByRole("button", { name: "Confirm Save" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).toContain("review a new preview");
  expect(save).toHaveBeenCalledTimes(1); expect(screen.queryByRole("button", { name: "Confirm Save" })).toBeNull();
});

it("leaves confirmed settings pending after a managed restart refusal, with no automatic rollback", async () => {
  await page.viewport(1440, 1100);
  vi.mocked(api.capabilitySetup).mockResolvedValue(eligibleCronSnapshot);
  vi.mocked(api.capabilityActions).mockResolvedValue(eligibleCronActions);
  const preview = { action: "cron-controls" as const, process: capabilityActions.process, expectedVersion: "a".repeat(64), changes: [], normalizesFormatting: true as const, exactBytes: false as const, noOp: false };
  vi.spyOn(api, "previewCapabilityAction").mockImplementation(async (sourceId, input) => { expect(sourceId).toBe("garden"); expect(input).toEqual({ action: preview.action, process: preview.process }); return preview; });
  const save = vi.spyOn(api, "saveCapabilityAction").mockImplementation(async () => {
    vi.mocked(api.capabilityActions).mockResolvedValue({ ...eligibleCronActions, actions: eligibleCronActions.actions.map((action) => action.id === "cron-controls" ? { ...action, reason: "already-configured" as const } : action) });
    return { action: preview.action, process: preview.process, version: "b".repeat(64), changed: true };
  });
  vi.spyOn(api, "requestAgentRestart").mockRejectedValue(new ApiError("Synthetic refusal", 409));
  render(<Preview width={1440} managed />);
  await userEvent.click(await screen.findByRole("button", { name: "Enable cron controls…" }));
  await userEvent.click(screen.getByRole("button", { name: "Confirm Save" }));
  await userEvent.click(await screen.findByRole("button", { name: "Restart to apply…" }));
  await userEvent.click(screen.getByRole("button", { name: "Confirm restart" }));
  await screen.findByText("Restart failed or was not confirmed. Saved settings remain; no automatic rollback.");
  expect(save).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Saved; applies on next start")).toBeVisible();
});

// Synthetic Memory flow uses the existing catalog example and the same mocked
// preview/save/restart boundaries as the cron flow above; no product-only UI.
for (const width of [390, 1440]) for (const managed of [true, false]) it(`captures the synthetic Memory Enable flow at ${width}px (${managed ? "managed" : "foreground"})`, async () => {
  await page.viewport(width, width === 390 ? 1900 : 1600);
  const unconfigured = {
    ...capabilitySnapshot,
    cards: capabilitySnapshot.cards.map((card) => card.id === "memory" ? {
      ...card, status: "disabled" as const, selectedVariant: undefined,
      evidence: card.evidence.map((item) => ({ ...item, status: "disabled" as const })),
      variants: card.variants?.map((variant) => ({ ...variant, status: "disabled" as const })),
    } : card),
  };
  const eligible = {
    ...capabilityActions,
    actions: capabilityActions.actions.map((action) => action.id === "memory-lite" ? { ...action, available: true, active: false, reason: "eligible" as const } : action),
  };
  vi.mocked(api.capabilitySetup).mockResolvedValue(unconfigured);
  vi.mocked(api.capabilityActions).mockResolvedValue(eligible);
  const lite = capabilitySnapshot.cards.find((card) => card.id === "memory")!.variants!.find((variant) => variant.id === "memory:lite")!;
  const example = JSON.parse(lite.steps.find((step) => step.trimStart().startsWith("{"))!) as { memory: unknown };
  const preview = { action: "memory-lite" as const, process: eligible.process, expectedVersion: "a".repeat(64), changes: [{ field: "memory" as const, value: JSON.stringify(example.memory, null, 2) }], normalizesFormatting: true as const, exactBytes: false as const, noOp: false };
  vi.spyOn(api, "previewCapabilityAction").mockImplementation(async (sourceId, input) => { expect(sourceId).toBe("garden"); expect(input).toEqual({ action: preview.action, process: preview.process }); return preview; });
  const save = vi.spyOn(api, "saveCapabilityAction").mockImplementation(async () => {
    vi.mocked(api.capabilityActions).mockResolvedValue({ ...eligible, actions: eligible.actions.map((action) => action.id === "memory-lite" ? { ...action, reason: "already-configured" as const } : action) });
    return { action: preview.action, process: preview.process, version: "b".repeat(64), changed: true };
  });
  const restart = vi.spyOn(api, "requestAgentRestart");
  render(<Preview width={width} managed={managed} />);
  const memory = await screen.findByRole("article", { name: "Memory" });
  const capture = async (state: string) => {
    await settleAndReveal(width);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    if (shots) await page.screenshot({ path: `${shots}/capabilities-synthetic-enable-flow-${width}-${state}.png` });
  };
  const enable = await within(memory).findByRole("button", { name: "Enable Memory Lite…" });
  expect(enable).toBeVisible();
  expect(within(memory).getByRole("heading", { name: "Memory" }).parentElement).toHaveTextContent("Disabled");
  expect(within(memory).queryByText("Active")).toBeNull();
  if (managed) await capture("eligible");
  await userEvent.click(enable);
  expect(within(memory).getByLabelText("Owned-field preview").textContent).toBe(preview.changes[0]!.value);
  const confirm = within(memory).getByRole("button", { name: "Confirm Save" });
  expect(confirm).toBeVisible();
  expect(save).not.toHaveBeenCalled();
  if (managed) await capture("preview");
  await userEvent.click(confirm);
  await within(memory).findByText("Saved; applies on next start");
  expect(save).toHaveBeenCalledWith("garden", { action: "memory-lite", process: preview.process, expectedVersion: preview.expectedVersion, confirmed: true });
  expect(restart).not.toHaveBeenCalled();
  if (managed) await waitFor(() => expect(within(memory).getByRole("button", { name: "Restart to apply…" })).toBeEnabled());
  else expect(within(memory).queryByRole("button", { name: "Restart to apply…" })).toBeNull();
  await capture(managed ? "managed-saved" : "foreground-saved");
});

for (const width of [390, 1440]) for (const state of ["empty", "set-status", "config-pending", "saved-restart", "uncertain"] as const) it(`captures synthetic credential ${state} at ${width}px and clears write-only state`, async () => {
  await page.viewport(width, width === 390 ? 1900 : 1600);
  const view: import("./types").WebCredentialSnapshot = {
    version: 1, process: capabilityActions.process, fence: "12345678-1234-1234-1234-123456789012",
    cards: [
      { id: "telegram", available: true, reason: "ready", fields: [{ id: "bot", state: state === "set-status" ? "set" : "not-set" }], configReady: false, configPending: false },
      { id: "slack", available: true, reason: "ready", fields: [{ id: "bot", state: "not-set" }, { id: "app", state: "not-set" }], configReady: false, configPending: false },
      { id: "openai-api", available: true, reason: "ready", fields: [{ id: "bearer", state: "not-set" }], configReady: false, configPending: false },
    ],
  };
  vi.spyOn(api, "credentials").mockResolvedValue(view);
  const plantedValue = ["fictional", "browser", "literal"].join("-");
  const save = vi.spyOn(api, "saveCredentials").mockImplementation(async () => {
    expect(Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"]')).every((field) => field.value === "")).toBe(true);
    if (state === "uncertain") throw new ApiError("Unconfirmed", 502, "credential_outcome_unknown");
    vi.mocked(api.credentials).mockResolvedValue({ ...view, cards: view.cards.map((item) => item.id === "telegram" ? { ...item, fields: [{ id: "bot", state: "set" }], configReady: state !== "config-pending", configPending: state === "config-pending" } : item) });
    return { card: "telegram", process: view.process, outcome: state === "config-pending" ? "saved-config-pending" : "saved" };
  });
  const retry = vi.spyOn(api, "retryCredentialConfig").mockImplementation(async () => {
    vi.mocked(api.credentials).mockResolvedValue({ ...view, cards: view.cards.map((item) => item.id === "telegram" ? { ...item, fields: [{ id: "bot", state: "set" }], configReady: true, configPending: false } : item) });
    return { card: "telegram", process: view.process, outcome: "saved" };
  });
  render(<Preview width={width} credentials managed={state === "saved-restart"} />);
  const telegram = await screen.findByRole("article", { name: "Telegram" });
  await within(telegram).findByRole("form", { name: "Save telegram credentials" });
  const password = within(telegram).getByLabelText("Bot credential") as HTMLInputElement;
  expect(password.type).toBe("password"); expect(password.value).toBe("");
  if (!["empty", "set-status"].includes(state)) {
    await userEvent.type(password, plantedValue);
    await userEvent.type(within(telegram).getByLabelText("Allowed chat IDs"), "123");
    await userEvent.click(within(telegram).getByRole("button", { name: "Confirm Save credentials" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    if (state === "uncertain") await within(telegram).findByRole("alert");
    else await within(telegram).findByText(state === "config-pending" ? "Saved; config pending." : "Saved; applies on next start.");
  }
  await settleAndReveal(width); telegram.scrollIntoView({ block: "start" });
  expect(telegram.textContent).not.toContain(plantedValue);
  expect(JSON.stringify(localStorage)).not.toContain(plantedValue); expect(JSON.stringify(sessionStorage)).not.toContain(plantedValue);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  if (shots) await page.screenshot({ path: `${shots}/credentials-synthetic-${width}-${state}.png` });
  if (state === "config-pending") {
    await userEvent.click(within(telegram).getByRole("button", { name: "Retry configuration only" }));
    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    expect(retry.mock.calls[0]?.[1]).not.toHaveProperty("fields"); expect(save).toHaveBeenCalledTimes(1);
  }
  if (state === "saved-restart") {
    await userEvent.click(within(telegram).getByRole("button", { name: "Restart to apply…" }));
    expect(screen.getByText(/Restarting may interrupt active conversations/)).toBeVisible();
  }
  cleanup();
  render(<Preview width={width} credentials />);
  const fresh = await screen.findByRole("article", { name: "Telegram" });
  await waitFor(() => expect((within(fresh).getByLabelText("Bot credential") as HTMLInputElement).value).toBe(""));
  expect(save).toHaveBeenCalledTimes(["empty", "set-status"].includes(state) ? 0 : 1);
});

for (const width of [390, 1440]) for (const card of ["a2a", "embeddings", "parallel-search", "parallel-fetch", "ollama-search"] as const) for (const state of ["not-set", "set", "pending"] as const) it(`captures synthetic S2b ${card} ${state} at ${width}px`, async () => {
  const { credentialSnapshot } = await import("./test/capability-fixtures");
  vi.mocked(api.capabilitySetup).mockResolvedValue({ ...capabilitySnapshot, cards: capabilitySnapshot.cards.map((item) => {
    if (item.id !== "memory") return item;
    const journal = item.variants!.find((variant) => variant.id === "memory:journal")!;
    return { ...item, ...journal, id: "memory", status: "ok" as const, selectedVariant: "memory:journal" };
  }) });
  vi.mocked(api.capabilityActions).mockResolvedValue({ ...capabilityActions, actions: capabilityActions.actions.map((action) => action.id === "memory-lite" ? { ...action, active: false, available: false, reason: "already-configured" as const } : action) });
  await page.viewport(width, width === 390 ? 1900 : 1600);
  const fieldLabel = card === "a2a" ? "Provider bearer" : card === "embeddings" ? "Journal / BuJo embeddings key" : card === "parallel-search" ? "Parallel search key" : card === "parallel-fetch" ? "Parallel fetch key" : "Hosted Ollama search key";
  const view = { ...credentialSnapshot, cards: credentialSnapshot.cards.map((item) => item.id === card ? { ...item, fields: item.fields.map((field) => ({ ...field, state: state === "set" ? "set" as const : "not-set" as const })) } : item) };
  vi.spyOn(api, "credentials").mockResolvedValue(view);
  const plantedValue = ["fictional", "s2b", "literal"].join("-");
  const save = vi.spyOn(api, "saveCredentials").mockImplementation(async () => {
    expect(Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"]')).every((field) => field.value === "")).toBe(true);
    vi.mocked(api.credentials).mockResolvedValue({ ...view, cards: view.cards.map((item) => item.id === card ? { ...item, fields: item.fields.map((field) => ({ ...field, state: "set" as const })), configPending: true } : item) });
    return { card, process: view.process, outcome: "saved-config-pending" };
  });
  render(<Preview width={width} credentials />);
  const input = await screen.findByLabelText(fieldLabel) as HTMLInputElement;
  const section = input.closest(".capability-action") as HTMLElement;
  const controls = within(section);
  await waitFor(() => expect(controls.getByRole("button", { name: "Confirm Save credentials" })).toBeEnabled());
  if (state === "pending") {
    await userEvent.type(input, plantedValue);
    await userEvent.click(controls.getByRole("button", { name: "Confirm Save credentials" }));
    await controls.findByText("Saved; config pending."); await controls.findByText(`${fieldLabel}: set`);
    await waitFor(() => expect(controls.getByRole("button", { name: "Refresh credential status" })).toBeEnabled());
    expect(save).toHaveBeenCalledTimes(1); expect(save.mock.calls[0]![1]).toMatchObject({ card, fields: card === "a2a" ? { bearer: plantedValue } : { credential: plantedValue } });
  } else expect(save).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain(plantedValue); expect(JSON.stringify(localStorage)).not.toContain(plantedValue); expect(JSON.stringify(sessionStorage)).not.toContain(plantedValue);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  section.scrollIntoView({ block: "center" });
  if (shots) await page.screenshot({ path: `${shots}/credentials-synthetic-${width}-${card}-${state}.png` });
});

const undoableActions = {
  ...capabilityActions,
  actions: capabilityActions.actions.map((item) => item.id === "config-undo" ? { ...item, available: true, reason: "eligible" as const } : item.id === "subagents-enable" ? { ...item, available: true, reason: "eligible" as const } : item),
};
const staleUndoActions = {
  ...capabilityActions,
  actions: capabilityActions.actions.map((item) => item.id === "config-undo" ? { ...item, available: false, reason: "undo-stale" as const } : item.id === "subagents-enable" ? { ...item, available: true, reason: "eligible" as const } : item),
};
const undoPreview = { action: "config-undo" as const, process: capabilityActions.process, expectedVersion: "a".repeat(64), changes: [{ field: "config" as const, value: "Restore the exact prior file, including its formatting. The one-level slot is consumed; dotenv credentials and memory data are untouched." }], normalizesFormatting: false as const, exactBytes: true as const, noOp: false };
const subagentsPreview = { action: "subagents-enable" as const, process: capabilityActions.process, expectedVersion: "a".repeat(64), changes: [{ field: "subagents.enabled" as const, value: "true" }, { field: "tools.allowedTools" as const, value: "Append \"Agent\"; existing entries and deny rules are unchanged." }], normalizesFormatting: true as const, exactBytes: false as const, noOp: false };
function mockE2Previews() {
  vi.spyOn(api, "previewCapabilityAction").mockImplementation(async (_sourceId, input) => {
    if (input.action === "config-undo") return undoPreview;
    if (input.action === "subagents-enable") return subagentsPreview;
    throw new ApiError("Unsupported synthetic action", 400);
  });
}

for (const width of [390, 1440]) it(`offers one-level Undo and consumes the slot at ${width}px`, async () => {
  await page.viewport(width, width === 390 ? 1900 : 1600);
  vi.mocked(api.capabilitySetup).mockResolvedValue(capabilitySnapshot);
  vi.mocked(api.capabilityActions).mockResolvedValue(undoableActions);
  mockE2Previews();
  const save = vi.spyOn(api, "saveCapabilityAction").mockImplementation(async () => {
    vi.mocked(api.capabilityActions).mockResolvedValue({ ...undoableActions, actions: undoableActions.actions.map((item) => item.id === "config-undo" ? { ...item, available: false, reason: "undo-unavailable" as const } : item) });
    return { action: "config-undo", process: capabilityActions.process, version: "b".repeat(64), changed: true };
  });
  render(<Preview width={width} />);
  const recovery = await screen.findByRole("article", { name: "Configuration recovery" });
  expect(within(recovery).getByText(/A console save is on record and Undo is available/)).toBeVisible();
  if (shots) { recovery.scrollIntoView({ block: "start" }); await page.screenshot({ path: `${shots}/e2-undo-offered-${width}.png` }); }
  await userEvent.click(within(recovery).getByRole("button", { name: "Undo last console save…" }));
  expect(within(recovery).getByLabelText("Owned-field preview").textContent).toContain("exact prior bytes");
  if (shots) { recovery.scrollIntoView({ block: "start" }); await page.screenshot({ path: `${shots}/e2-undo-preview-${width}.png` }); }
  await userEvent.click(within(recovery).getByRole("button", { name: "Confirm Save" }));
  expect(save).toHaveBeenCalledWith("garden", { action: "config-undo", process: undoPreview.process, expectedVersion: undoPreview.expectedVersion, confirmed: true });
  await within(recovery).findByText("Saved; applies on next start");
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
});

for (const width of [390, 1440]) it(`refuses Undo after a manual edit without offering a write at ${width}px`, async () => {
  await page.viewport(width, width === 390 ? 1900 : 1600);
  vi.mocked(api.capabilitySetup).mockResolvedValue(capabilitySnapshot);
  vi.mocked(api.capabilityActions).mockResolvedValue(staleUndoActions);
  mockE2Previews();
  render(<Preview width={width} />);
  const recovery = await screen.findByRole("article", { name: "Configuration recovery" });
  expect(within(recovery).getByText(/changed since the last console save/)).toBeVisible();
  expect(within(recovery).queryByRole("button", { name: "Undo last console save…" })).toBeNull();
  expect(within(recovery).queryByRole("button", { name: "Confirm Save" })).toBeNull();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  if (shots) { recovery.scrollIntoView({ block: "start" }); await page.screenshot({ path: `${shots}/e2-undo-refused-${width}.png` }); }
});

for (const width of [390, 1440]) it(`previews subagents Enable without touching profiles or denies at ${width}px`, async () => {
  await page.viewport(width, width === 390 ? 1900 : 1600);
  vi.mocked(api.capabilitySetup).mockResolvedValue(capabilitySnapshot);
  vi.mocked(api.capabilityActions).mockResolvedValue(undoableActions);
  mockE2Previews();
  vi.spyOn(api, "saveCapabilityAction").mockImplementation(async () => {
    vi.mocked(api.capabilityActions).mockResolvedValue({ ...undoableActions, actions: undoableActions.actions.map((item) => item.id === "subagents-enable" ? { ...item, reason: "already-configured" as const } : item) });
    return { action: "subagents-enable", process: capabilityActions.process, version: "b".repeat(64), changed: true };
  });
  render(<Preview width={width} />);
  const subagents = await screen.findByRole("article", { name: "Subagents" });
  await userEvent.click(within(subagents).getByRole("button", { name: "Enable subagents…" }));
  expect(within(subagents).getAllByLabelText("Owned-field preview").map((node) => node.textContent)).toEqual(["true", "Append \"Agent\"; existing entries and deny rules are unchanged."]);
  expect(within(subagents).getByText("Only delegation is enabled. Profiles and deny rules are unchanged.")).toBeVisible();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  if (shots) { subagents.scrollIntoView({ block: "start" }); await page.screenshot({ path: `${shots}/e2-subagents-preview-${width}.png` }); }
  await userEvent.click(within(subagents).getByRole("button", { name: "Confirm Save" }));
  await within(subagents).findByText("Saved; applies on next start");
});

for (const width of [390, 1440]) it(`reports saved-not-active after a new start without promising the next one at ${width}px`, async () => {
  await page.viewport(width, width === 390 ? 1900 : 1600);
  vi.mocked(api.capabilitySetup).mockResolvedValue(eligibleCronSnapshot);
  vi.mocked(api.capabilityActions).mockResolvedValue(eligibleCronActions);
  const preview = { action: "cron-controls" as const, process: capabilityActions.process, expectedVersion: "a".repeat(64), changes: [], normalizesFormatting: true as const, exactBytes: false as const, noOp: false };
  vi.spyOn(api, "previewCapabilityAction").mockResolvedValue(preview);
  vi.spyOn(api, "saveCapabilityAction").mockImplementation(async () => {
    vi.mocked(api.capabilityActions).mockResolvedValue({ ...eligibleCronActions, actions: eligibleCronActions.actions.map((item) => item.id === "cron-controls" ? { ...item, reason: "already-configured" as const } : item) });
    return { action: "cron-controls", process: capabilityActions.process, version: "b".repeat(64), changed: true };
  });
  render(<Preview width={width} />);
  await userEvent.click(await screen.findByRole("button", { name: "Enable cron controls…" }));
  await userEvent.click(screen.getByRole("button", { name: "Confirm Save" }));
  await screen.findByText("Saved; applies on next start");
  vi.mocked(api.capabilityActions).mockResolvedValue({ ...eligibleCronActions, process: { ...capabilityActions.process, startedAt: "2026-08-01T10:01:00Z" }, actions: eligibleCronActions.actions.map((item) => item.id === "cron-controls" ? { ...item, active: false, reason: "already-configured" as const } : item) });
  await userEvent.click(screen.getByRole("button", { name: "Refresh capability status" }));
  const cron = await screen.findByRole("article", { name: "Scheduled jobs (cron)" });
  expect(within(cron).getByText("Saved, but not active at this start — check evidence")).toBeVisible();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  if (shots) { cron.scrollIntoView({ block: "start" }); await page.screenshot({ path: `${shots}/e2-saved-not-active-${width}.png` }); }
});
