import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CapabilitiesSection } from "./CapabilitiesSection";
import { capabilitySnapshot } from "../../test/capability-fixtures";
import { CredentialControls, type CredentialNotice } from "./CredentialControls";
import { api, ApiError } from "../../api";
import { agent } from "../../test/fixtures";
import type { WebCredentialSnapshot } from "../../types";
function Controls() {
  const [notice, setNotice] = useState<CredentialNotice | null>(null);
  return <CredentialControls agent={agent("fictional", { generation: "one" })} card="telegram" restart={null} notice={notice} setNotice={setNotice} />;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const view: WebCredentialSnapshot = { version: 1, process: { pid: 42, startedAt: "2026-01-01T00:00:00.000Z" }, fence: "12345678-1234-1234-1234-123456789012", cards: [{ id: "telegram", available: true, reason: "ready", fields: [{ id: "bot", state: "not-set" }], configReady: false, configPending: false }] };
it("clears DOM on dispatch/failure/navigation, preserves uncertainty and never retries credentials", async () => {
  vi.spyOn(api, "credentials").mockResolvedValue(view);
  const save = vi.spyOn(api, "saveCredentials").mockRejectedValue(new ApiError("Unconfirmed", 502, "credential_outcome_unknown"));
  const plantedValue = ["fictional", "ui", "literal"].join("-");
  const rendered = render(<Controls />);
  const input = await screen.findByLabelText("Bot credential") as HTMLInputElement;
  await waitFor(() => expect(screen.getByRole("button", { name: "Confirm Save credentials" })).toBeEnabled());
  fireEvent.change(input, { target: { value: plantedValue } }); fireEvent.submit(screen.getByRole("form"));
  expect(input.value).toBe(""); await screen.findByRole("alert"); expect(document.body.textContent).not.toContain(plantedValue);
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Refresh credential status" })); expect(save).toHaveBeenCalledTimes(1);
  fireEvent.change(await screen.findByLabelText("Bot credential"), { target: { value: plantedValue } });
  rendered.unmount(); render(<Controls />);
  expect((await screen.findByLabelText("Bot credential") as HTMLInputElement).value).toBe(""); expect(save).toHaveBeenCalledTimes(1);
});

it("preserves the snapshot during refresh, reconciles uncertainty only on explicit refresh and allows dismissal", async () => {
  let release!: (value: WebCredentialSnapshot) => void;
  const read = vi.spyOn(api, "credentials").mockResolvedValue(view);
  vi.spyOn(api, "saveCredentials").mockRejectedValue(new ApiError("Unconfirmed", 502, "credential_outcome_unknown"));
  render(<Controls />); await screen.findByRole("form");
  await waitFor(() => expect(screen.getByRole("button", { name: "Confirm Save credentials" })).toBeEnabled());
  fireEvent.submit(screen.getByRole("form"));
  await screen.findByText(/Save outcome uncertain/);
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh credential status" })).toBeEnabled());
  read.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh credential status" }));
  expect(screen.getByText("Bot credential: not set")).toBeVisible(); expect(screen.getByText("Refreshing credential status…")).toBeVisible();
  expect(screen.queryByText(/Credential status unavailable/)).toBeNull();
  await act(async () => release({ ...view, cards: [{ ...view.cards[0]!, fields: [{ id: "bot", state: "set" }] }] }));
  expect(screen.getByRole("alert")).toHaveTextContent("Previous outcome was uncertain; status now shows Bot credential: set");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss uncertainty note" })); expect(screen.queryByRole("alert")).toBeNull();
});
it("preserves uncertainty through a generation change, card remount and delayed result without resending", async () => {
  vi.spyOn(api, "capabilitySetup").mockResolvedValue(capabilitySnapshot);
  vi.spyOn(api, "credentials").mockResolvedValue(view);
  let release!: (result: Awaited<ReturnType<typeof api.saveCredentials>>) => void;
  const save = vi.spyOn(api, "saveCredentials").mockImplementation(() => new Promise((resolve) => { release = resolve; }));
  const selected = agent("fictional", { generation: "one", supportsCapabilitySetup: true, supportsCredentialSetup: true });
  const rendered = render(<CapabilitiesSection agent={selected} />);
  const target = await screen.findByRole("form", { name: "Save telegram credentials" });
  await waitFor(() => expect(target.querySelector("button")).toBeEnabled());
  const plantedValue = ["fictional", "pending", "value"].join("-");
  fireEvent.change(screen.getByLabelText("Bot credential", { selector: "input[name=bot]" }), { target: { value: plantedValue } });
  fireEvent.submit(target); fireEvent.submit(target); expect(save).toHaveBeenCalledTimes(1);
  const next = { ...selected, generation: "two" };
  rendered.rerender(<CapabilitiesSection agent={next} />);
  await waitFor(() => expect(screen.getByText(/Save outcome uncertain/)).toBeVisible());
  await act(async () => release({ card: "telegram", process: view.process, outcome: "saved" }));
  await screen.findByRole("form", { name: "Save telegram credentials" });
  expect(screen.getByText(/Save outcome uncertain/)).toBeVisible(); expect(screen.queryByText("Saved; applies on next start.")).toBeNull();
  rendered.rerender(<CapabilitiesSection agent={{ ...next, status: "offline" }} />);
  expect(screen.getByText(/Save outcome uncertain/)).toBeVisible();
  rendered.rerender(<CapabilitiesSection agent={next} />);
  await screen.findByRole("form", { name: "Save telegram credentials" }); expect(screen.getByText(/Save outcome uncertain/)).toBeVisible();
  expect((screen.getByLabelText("Bot credential", { selector: "input[name=bot]" }) as HTMLInputElement).value).toBe("");
  expect(document.body.textContent).not.toContain(plantedValue); expect(save).toHaveBeenCalledTimes(1);
  vi.mocked(api.credentials).mockResolvedValue({ ...view, cards: [{ ...view.cards[0]!, fields: [{ id: "bot", state: "set" }] }] });
  await waitFor(() => expect(within(screen.getByRole("article", { name: "Telegram" })).getByRole("button", { name: "Refresh credential status" })).toBeEnabled());
  fireEvent.click(within(screen.getByRole("article", { name: "Telegram" })).getByRole("button", { name: "Refresh credential status" }));
  await screen.findByText(/Previous outcome was uncertain; status now shows Bot credential: set/);
  rendered.rerender(<CapabilitiesSection agent={{ ...next, generation: "three" }} />);
  await screen.findByRole("form", { name: "Save telegram credentials" });
  expect(screen.queryByText(/Previous outcome was uncertain; status now shows/)).toBeNull();
  expect(screen.getByText(/Save outcome uncertain/)).toBeVisible(); expect(save).toHaveBeenCalledTimes(1);
});
it("treats agent_not_found as a definite refusal", async () => {
  vi.spyOn(api, "credentials").mockResolvedValue(view);
  vi.spyOn(api, "saveCredentials").mockRejectedValue(new ApiError("Missing", 404, "agent_not_found"));
  render(<Controls />); await screen.findByRole("form"); await waitFor(() => expect(screen.getByRole("button", { name: "Confirm Save credentials" })).toBeEnabled());
  fireEvent.submit(screen.getByRole("form")); expect(await screen.findByRole("alert")).toHaveTextContent("Save refused"); expect(screen.queryByText(/Save outcome uncertain/)).toBeNull();
});
it.each([2048, 2049])("enforces UTF-8 byte size before dispatch with %i two-byte characters", async (count) => {
  vi.spyOn(api, "credentials").mockResolvedValue(view);
  const save = vi.spyOn(api, "saveCredentials").mockResolvedValue({ card: "telegram", process: view.process, outcome: "saved" });
  render(<Controls />); const input = await screen.findByLabelText("Bot credential") as HTMLInputElement;
  await waitFor(() => expect(screen.getByRole("button", { name: "Confirm Save credentials" })).toBeEnabled());
  fireEvent.change(input, { target: { value: "é".repeat(count) } }); fireEvent.submit(screen.getByRole("form")); expect(input.value).toBe("");
  if (count === 2049) { expect(await screen.findByRole("alert")).toHaveTextContent("Value too long"); expect(save).not.toHaveBeenCalled(); }
  else { await screen.findByText("Saved; applies on next start."); expect(save).toHaveBeenCalledTimes(1); }
});
it("renders a non-blocking environment override note without claiming enablement", async () => {
  vi.spyOn(api, "credentials").mockResolvedValue({ ...view, cards: [{ ...view.cards[0]!, environmentOverrides: true }] });
  render(<Controls />); expect(await screen.findByText(/Environment overrides some settings/)).toBeVisible();
  expect(screen.getByRole("form")).toBeVisible(); expect(screen.queryByText(/enable this channel/)).toBeNull();
});

it.each(["saved", "saved-config-pending"] as const)("does not carry a confirmed %s activation/retry promise into another generation", async (outcome) => {
  vi.spyOn(api, "capabilitySetup").mockResolvedValue(capabilitySnapshot);
  vi.spyOn(api, "credentials").mockResolvedValue(view);
  const save = vi.spyOn(api, "saveCredentials").mockResolvedValue({ card: "telegram", process: view.process, outcome });
  const selected = agent("fictional", { generation: "one", supportsCapabilitySetup: true, supportsCredentialSetup: true });
  const rendered = render(<CapabilitiesSection agent={selected} />);
  const target = await screen.findByRole("form", { name: "Save telegram credentials" });
  await waitFor(() => expect(target.querySelector("button")).toBeEnabled()); fireEvent.submit(target);
  await screen.findByText(outcome === "saved" ? "Saved; applies on next start." : "Saved; config pending.");
  rendered.rerender(<CapabilitiesSection agent={{ ...selected, generation: "two" }} />);
  await screen.findByRole("form", { name: "Save telegram credentials" });
  expect(screen.queryByText("Saved; applies on next start.")).toBeNull(); expect(screen.queryByRole("button", { name: "Retry configuration only" })).toBeNull();
  expect(screen.queryByText(/Save outcome uncertain/)).toBeNull(); expect(save).toHaveBeenCalledTimes(1);
});

it("retains a Parallel submission's uncertainty across a generation remount without replay", async () => {
  const { credentialSnapshot } = await import("../../test/capability-fixtures");
  vi.spyOn(api, "capabilitySetup").mockResolvedValue(capabilitySnapshot); vi.spyOn(api, "credentials").mockResolvedValue(credentialSnapshot);
  let reject!: (reason: Error) => void;
  const save = vi.spyOn(api, "saveCredentials").mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  const selected = agent("fictional", { generation: "one", supportsCapabilitySetup: true, supportsCredentialSetup: true });
  const rendered = render(<CapabilitiesSection agent={selected} />);
  const target = await screen.findByRole("form", { name: "Save parallel-search credentials" }); await waitFor(() => expect(target.querySelector("button")).toBeEnabled());
  const plantedValue = ["fictional", "parallel", "value"].join("-"); fireEvent.change(within(target).getByLabelText("Parallel search key"), { target: { value: plantedValue } }); fireEvent.submit(target);
  rendered.rerender(<CapabilitiesSection agent={{ ...selected, generation: "two" }} />);
  await act(async () => reject(new ApiError("Unknown", 502, "credential_outcome_unknown")));
  await screen.findByRole("form", { name: "Save parallel-search credentials" }); expect(screen.getByText(/Save outcome uncertain/)).toBeVisible();
  expect((screen.getByLabelText("Parallel search key") as HTMLInputElement).value).toBe(""); expect(document.body.textContent).not.toContain(plantedValue); expect(save).toHaveBeenCalledTimes(1);
});
