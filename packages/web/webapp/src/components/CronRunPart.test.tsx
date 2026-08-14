import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useConsoleStore } from "../console-store";
import { CronRunPart } from "./Messages";

vi.mock("../console-store", () => ({ useConsoleStore: vi.fn() }));

const loadCronRunActivity = vi.fn().mockResolvedValue(undefined);

describe("CronRunPart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useConsoleStore).mockReturnValue({ loadCronRunActivity } as unknown as ReturnType<typeof useConsoleStore>);
  });

  it("announces persisted activity truncation and field truncation", () => {
    render(<CronRunPart type="data" name="cron-run" status={{ type: "complete" }} data={{
      runId: "cron:digest:one",
      trigger: "scheduled",
      status: "succeeded",
      sequence: 1,
      eventCount: 30,
      activityLoaded: true,
      loadedEventCount: 1,
      eventsTruncated: true,
      fieldsTruncated: ["text", "error"],
    }} />);

    expect(screen.getByText("Activity is truncated; retained and wire-bounded events are shown."))
      .toHaveAttribute("role", "status");
    expect(screen.getByText("Run text, error are truncated in this view."))
      .toHaveAttribute("role", "status");
    expect(screen.getByRole("group", {
      name: "Cron run cron:digest:one, scheduled, completed",
    })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Load activity" })).not.toBeInTheDocument();
  });

  it("loads selected activity on demand and offers refresh when the persisted activity is stale", async () => {
    const { rerender } = render(<CronRunPart type="data" name="cron-run" status={{ type: "complete" }} data={{
      runId: "cron:digest:two",
      trigger: "manual",
      status: "failed",
      sequence: 2,
      eventCount: 2,
    }} />);
    fireEvent.click(screen.getByRole("button", { name: "Load activity" }));
    await waitFor(() => expect(loadCronRunActivity).toHaveBeenCalledWith("cron:digest:two"));

    rerender(<CronRunPart type="data" name="cron-run" status={{ type: "complete" }} data={{
      runId: "cron:digest:two",
      trigger: "manual",
      status: "failed",
      sequence: 2,
      eventCount: 3,
      activityLoaded: true,
      activityStale: true,
    }} />);
    expect(screen.getByRole("button", { name: "Refresh activity" })).toBeEnabled();
  });
});
