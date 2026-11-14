import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, ApiError } from "../../api";
import { eligibleCronActions } from "../../test/capability-fixtures";
import { agent } from "../../test/fixtures";
import { CapabilityActionControls, type CapabilityRestartState, type CapabilitySavedState } from "./CapabilityActionControls";

const process = eligibleCronActions.process;
const action = eligibleCronActions.actions.find((item) => item.id === "cron-controls")!;
const preview = { action: "cron-controls" as const, process, expectedVersion: "a".repeat(64), changes: [], normalizesFormatting: true as const, exactBytes: false as const, noOp: false };
const refresh = vi.fn();
function Controls({ fresh = false, active = false, configured = false, restart = null }: { fresh?: boolean; active?: boolean; configured?: boolean; restart?: CapabilityRestartState }) {
  const [saved, setSaved] = useState<CapabilitySavedState | null>(null);
  return <CapabilityActionControls agent={agent("garden", { restart: { supported: restart !== null } })} action={{ ...action, active, ...(configured ? { reason: "already-configured" as const } : {}) }} process={fresh ? { ...process, startedAt: "2026-08-01T10:01:00Z" } : process} restart={restart} refresh={refresh} saved={saved} setSaved={setSaved} />;
}
beforeEach(() => {
  refresh.mockClear();
  vi.spyOn(api, "previewCapabilityAction").mockResolvedValue(preview);
  vi.spyOn(api, "saveCapabilityAction").mockResolvedValue({ action: preview.action, process, version: "b".repeat(64), changed: true });
});
afterEach(() => vi.restoreAllMocks());
async function confirmSave() {
  fireEvent.click(screen.getByRole("button", { name: "Enable cron controls…" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm Save" }));
}
it("does not imply a write when preview fails", async () => {
  vi.mocked(api.previewCapabilityAction).mockRejectedValue(new ApiError("fictional diagnostic", 500));
  render(<Controls />);
  fireEvent.click(screen.getByRole("button", { name: "Enable cron controls…" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not read the preview; nothing was saved");
  expect(screen.getByRole("alert")).not.toHaveTextContent("rollback");
  expect(api.saveCapabilityAction).not.toHaveBeenCalled();
});
it("distinguishes a settings conflict from an uncertain save", async () => {
  vi.mocked(api.saveCapabilityAction).mockRejectedValue(new ApiError("fictional diagnostic", 409, "capability_action_conflict"));
  render(<Controls />); await confirmSave();
  expect(await screen.findByRole("alert")).toHaveTextContent("review a new preview");
  expect(screen.getByRole("alert")).not.toHaveTextContent("may have completed");
  expect(refresh).toHaveBeenCalledOnce();
});
it.each([["agent_generation_changed", 409], ["capability_action_failed", 503], [undefined, 409], [undefined, 500]] as const)("retains save uncertainty through a new process (%s, %s)", async (code, status) => {
  vi.mocked(api.saveCapabilityAction).mockRejectedValue(new ApiError("fictional diagnostic", status, code));
  const view = render(<Controls />); await confirmSave();
  expect(await screen.findByRole("alert")).toHaveTextContent("A save may have completed; inspect the configuration before retrying");
  view.rerender(<Controls fresh />);
  expect(screen.getByRole("alert")).toHaveTextContent("A save may have completed");
  expect(screen.queryByText("Saved; applies on next start")).toBeNull();
});
it.each(["agent_offline", "capability_action_unavailable", "capability_actions_unsupported"])("offers manual/connection guidance rather than a retry promise (%s)", async (code) => {
  vi.mocked(api.saveCapabilityAction).mockRejectedValue(new ApiError("fictional diagnostic", 409, code));
  render(<Controls />); await confirmSave();
  const alert = await screen.findByRole("alert");
  expect(alert).not.toHaveTextContent("review a new preview");
  expect(alert).toHaveTextContent(code === "agent_offline" ? "agent is offline" : "manual setup guidance");
});
it("reports an observed new start without activation instead of promising a future start", async () => {
  const view = render(<Controls />); await confirmSave();
  await screen.findByText("Saved; applies on next start");
  view.rerender(<Controls fresh />);
  expect(screen.getByText("Saved, but not active at this start — check evidence")).toBeVisible();
  expect(screen.queryByText("Saved; applies on next start")).toBeNull();
  view.rerender(<Controls fresh active />);
  expect(screen.getByText("Active")).toBeVisible();
});
it("shows confirmation before surfacing an unconfirmed restart request", async () => {
  const restartAgain = vi.fn();
  function Fixture() {
    const [unknown, setUnknown] = useState(false);
    const [confirming, setConfirming] = useState(false);
    restartAgain.mockImplementation(() => { setUnknown(false); setConfirming(true); });
    const restart = { readState: "ready", requestUnknown: unknown, restartAgain } as unknown as CapabilityRestartState;
    return <><Controls restart={restart} />{confirming && <button onClick={() => { setConfirming(false); setUnknown(true); }}>Submit synthetic restart</button>}</>;
  }
  render(<Fixture />); await confirmSave();
  fireEvent.click(await screen.findByRole("button", { name: "Restart to apply…" }));
  expect(screen.queryByText(/Restart not confirmed/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Submit synthetic restart" }));
  expect(screen.getByText(/Restart not confirmed — check the agent before retrying/)).toBeVisible();
  expect(restartAgain).toHaveBeenCalledOnce();
});
it.each(["resolved", "rejected"])("retains uncertainty when a pending Save is %s after a generation change", async (outcome) => {
  let finish!: () => void;
  vi.mocked(api.saveCapabilityAction).mockImplementation(() => new Promise((resolve, reject) => {
    finish = () => outcome === "resolved" ? resolve({ action: preview.action, process, version: "b".repeat(64), changed: true }) : reject(new ApiError("Fictional stale response", 409, "capability_action_conflict"));
  }));
  const view = render(<Controls />); await confirmSave();
  view.rerender(<Controls fresh />);
  await act(async () => finish());
  expect(await screen.findByRole("alert")).toHaveTextContent("A save may have completed");
  expect(api.saveCapabilityAction).toHaveBeenCalledOnce();
});
it("does not attribute pre-existing pending configuration to a console Save", () => {
  const restartAgain = vi.fn();
  render(<Controls configured restart={{ readState: "ready", restartAgain } as unknown as CapabilityRestartState} />);
  expect(screen.getByText("Configured; not active at this start")).toBeVisible();
  expect(screen.queryByText("Saved; applies on next start")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Restart to apply…" }));
  expect(screen.getByText("Configured; not active at this start")).toBeVisible();
  expect(api.saveCapabilityAction).not.toHaveBeenCalled();
});

it("labels subagents and undo actions with their own confirm copy", async () => {
  function Variant({ target }: { readonly target: (typeof eligibleCronActions.actions)[number] }) {
    const [saved, setSaved] = useState<CapabilitySavedState | null>(null);
    return <CapabilityActionControls agent={agent("garden", { restart: { supported: false } })} action={target} process={eligibleCronActions.process} restart={null} refresh={refresh} saved={saved} setSaved={setSaved} />;
  }
  const subAction = { ...eligibleCronActions.actions.find((item) => item.id === "subagents-enable")!, available: true, reason: "eligible" as const };
  const subPreview = { action: "subagents-enable" as const, process: eligibleCronActions.process, expectedVersion: "a".repeat(64), changes: [{ field: "subagents.enabled" as const, value: "true" }], normalizesFormatting: true as const, exactBytes: false as const, noOp: false };
  vi.mocked(api.previewCapabilityAction).mockResolvedValue(subPreview as never);
  const view = render(<Variant target={subAction} />);
  fireEvent.click(await screen.findByRole("button", { name: "Enable subagents…" }));
  await screen.findByText("Only delegation is enabled. Profiles and deny rules are unchanged.");
  const undoAction = { ...eligibleCronActions.actions.find((item) => item.id === "config-undo")!, available: true, reason: "eligible" as const };
  const undoPreview = { action: "config-undo" as const, process: eligibleCronActions.process, expectedVersion: "a".repeat(64), changes: [{ field: "config" as const, value: "Restore." }], normalizesFormatting: false as const, exactBytes: true as const, noOp: false };
  vi.mocked(api.previewCapabilityAction).mockResolvedValue(undoPreview as never);
  view.rerender(<Variant target={undoAction} />);
  fireEvent.click(await screen.findByRole("button", { name: "Undo last console save…" }));
  await screen.findByText(/dotenv credentials and memory data are untouched/);
});

it.each([["subagents-denied", "The tool policy denies Agent"], ["subagents-unconfigured", "Subagents are not configured"], ["undo-stale", "changed since the last console save"], ["undo-unavailable", "No console save is available"], ["candidate-invalid", "no longer valid"]] as const)("explains a %s refusal without offering a write", (reason, copy) => {
  function Variant({ target }: { readonly target: (typeof eligibleCronActions.actions)[number] }) {
    const [saved, setSaved] = useState<CapabilitySavedState | null>(null);
    return <CapabilityActionControls agent={agent("garden", { restart: { supported: false } })} action={target} process={eligibleCronActions.process} restart={null} refresh={refresh} saved={saved} setSaved={setSaved} />;
  }
  const id = reason.startsWith("undo") ? "config-undo" : "subagents-enable";
  const refused = { ...eligibleCronActions.actions.find((item) => item.id === id)!, available: false, active: false, reason };
  render(<Variant target={refused} />);
  expect(screen.getByText(new RegExp(copy))).toBeVisible();
  expect(screen.queryByRole("button", { name: /Enable|Undo/ })).toBeNull();
});

it("reports an invalid candidate definitely instead of an uncertain save", async () => {
  vi.mocked(api.saveCapabilityAction).mockRejectedValue(new ApiError("fictional diagnostic", 409, "capability_action_invalid"));
  render(<Controls />);
  fireEvent.click(screen.getByRole("button", { name: "Enable cron controls…" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm Save" }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("no longer valid");
  expect(alert).not.toHaveTextContent("may have completed");
  expect(refresh).toHaveBeenCalled();
});
