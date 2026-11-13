import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, ApiError } from "../../api";
import { eligibleCronActions } from "../../test/capability-fixtures";
import { agent } from "../../test/fixtures";
import { CapabilityActionControls, type CapabilityRestartState, type CapabilitySavedState } from "./CapabilityActionControls";

const process = eligibleCronActions.process;
const action = eligibleCronActions.actions.find((item) => item.id === "cron-controls")!;
const preview = { action: "cron-controls" as const, process, expectedVersion: "a".repeat(64), changes: [], normalizesFormatting: true as const, noOp: false };
const refresh = vi.fn();
function Controls({ fresh = false, active = false, restart = null }: { fresh?: boolean; active?: boolean; restart?: CapabilityRestartState }) {
  const [saved, setSaved] = useState<CapabilitySavedState | null>(null);
  return <CapabilityActionControls agent={agent("garden", { restart: { supported: restart !== null } })} action={{ ...action, active }} process={fresh ? { ...process, startedAt: "2026-08-01T10:01:00Z" } : process} restart={restart} refresh={refresh} saved={saved} setSaved={setSaved} />;
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
it("surfaces an unconfirmed restart request even without an outcome or operation ID", async () => {
  const restartAgain = vi.fn();
  const restart = { readState: "ready", requestUnknown: true, restartAgain } as unknown as CapabilityRestartState;
  render(<Controls restart={restart} />); await confirmSave();
  fireEvent.click(await screen.findByRole("button", { name: "Restart to apply…" }));
  expect(screen.getByText(/Restart not confirmed — check the agent before retrying/)).toBeVisible();
  expect(restartAgain).toHaveBeenCalledOnce();
});
