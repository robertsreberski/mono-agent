import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime } from "@assistant-ui/react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { commands, page, userEvent } from "@vitest/browser/context";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { WebWakeSchedule } from "../../../src/contracts.js";
import { ApiError, api } from "../api";
import { convertWebMessage } from "../runtime";
import type { ThreadSummary, WebMessage } from "../types";
import { AssistantMessage, SystemMessage, UserMessage } from "./Messages";
import { Icon } from "./Icon";
import { WakeScheduleEditor } from "./WakeScheduleEditor";
import { WakeScheduleStatus } from "./WakeScheduleStatus";
import "../styles.css";

const screenshots = import.meta.env.VITE_WAKE_SCHEDULE_SHOTS as string | undefined;
const capture = async (name: string) => {
  if (screenshots) await page.screenshot({ path: `${screenshots}/${name}.png` });
};
const thread = {
  id: "fictional-thread", sourceId: "fictional-agent", title: "Sample conversation", archivedAt: null,
  wakeSchedule: { state: "active", kind: "weekly", revision: 2, nextFireAt: "2027-01-04T09:00:00.000Z" },
} as ThreadSummary;
const schedule = { scheduleId: "sample-schedule", threadId: thread.id, sourceId: thread.sourceId,
  definition: { kind: "weekly" as const, timezone: "UTC", days: [1, 3], times: ["09:00", "14:30"], message: "Review the sample." },
  state: "active" as const, revision: 2, nextFireAt: "2027-01-04T09:00:00.000Z", lastOutcome: null,
  createdAt: "2027-01-01T09:00:00.000Z",
};
function Transcript({ message }: { message: WebMessage }) {
  const runtime = useExternalStoreRuntime<WebMessage>({ messages: [message], convertMessage: (value) => convertWebMessage(value), onNew: async () => undefined });
  return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Root>
    <ThreadPrimitive.Messages components={{ AssistantMessage, SystemMessage, UserMessage }} />
  </ThreadPrimitive.Root></AssistantRuntimeProvider>;
}
const dialog = () => screen.getByRole("dialog", { name: "Scheduled wake-up" });
const loadedEditor = async (value: WebWakeSchedule | null = schedule, target: ThreadSummary = thread) => {
  const read = vi.spyOn(api, "wakeSchedule").mockResolvedValue({ schedule: value });
  const close = vi.fn();
  const view = render(<WakeScheduleEditor thread={target} onClose={close} />);
  await waitFor(() => expect(screen.getByLabelText("Message")).toBeEnabled());
  return { read, close, view };
};

/** An opener that survives the dialog, like the conversation header's actions button. */
function Opener({ target = thread }: { target?: ThreadSummary }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <div>
    <button ref={trigger} type="button" onClick={() => setOpen(true)}>Conversation actions</button>
    <button type="button" onClick={() => undefined}>Background action</button>
    {open && <WakeScheduleEditor thread={target} returnFocusRef={trigger} onClose={() => setOpen(false)} />}
  </div>;
}

describe("scheduled wake UI in Chromium", () => {
  it("preserves a dirty draft across a live summary revision, reports a stale save and closes on Escape", async () => {
    const read = vi.spyOn(api, "wakeSchedule").mockResolvedValueOnce({ schedule })
      .mockResolvedValueOnce({ schedule: { ...schedule, revision: 3,
        definition: { ...schedule.definition, message: "Changed elsewhere." } } });
    const save = vi.spyOn(api, "saveWakeSchedule").mockRejectedValue(new Error("Schedule changed; reload and retry."));
    const close = vi.fn();
    const editor = render(<WakeScheduleEditor thread={thread} onClose={close} />);
    await waitFor(() => expect(screen.getByLabelText("Message")).toHaveValue("Review the sample."));
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Local draft." } });
    editor.rerender(<WakeScheduleEditor thread={{ ...thread, wakeSchedule: { ...thread.wakeSchedule!, revision: 3 } }} onClose={close} />);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/Changed elsewhere/u));
    expect(screen.getByLabelText("Message")).toHaveValue("Local draft.");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Schedule changed/u));
    expect(save).toHaveBeenCalledWith(thread.id, expect.objectContaining({ message: "Local draft." }), 2);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    editor.unmount(); read.mockRestore(); save.mockRestore();
  });

  it("keeps the form disabled until the first read, then formats the saved next time in the schedule zone", async () => {
    let resolve: (value: { schedule: typeof schedule }) => void = () => undefined;
    const read = vi.spyOn(api, "wakeSchedule").mockReturnValue(new Promise((done) => { resolve = done; }));
    const zoned = { ...schedule, definition: { ...schedule.definition, timezone: "America/Chicago" } };
    const view = render(<WakeScheduleEditor thread={thread} onClose={() => undefined} />);
    expect(screen.getByLabelText("Message")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await act(async () => { resolve({ schedule: zoned }); });
    await waitFor(() => expect(screen.getByLabelText("Message")).toBeEnabled());
    const summary = screen.getByRole("region", { name: "Schedule summary" });
    expect(summary).toHaveTextContent("Every Mon and Wed at");
    const inZone = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "America/Chicago" }).format(new Date(schedule.nextFireAt));
    expect(summary).toHaveTextContent(`Next: ${inZone}`);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    view.unmount(); read.mockRestore();
  });

  it("confirms deletion in place and returns focus to the row on cancel", async () => {
    const { read, close, view } = await loadedEditor();
    const remove = vi.spyOn(api, "deleteWakeSchedule").mockResolvedValue(undefined);
    await userEvent.click(screen.getByRole("button", { name: "Delete schedule" }));
    expect(remove).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Keep schedule" })).toHaveFocus());
    await userEvent.click(screen.getByRole("button", { name: "Keep schedule" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete schedule" })).toHaveFocus());
    await userEvent.click(screen.getByRole("button", { name: "Delete schedule" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(thread.id, 2));
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    view.unmount(); read.mockRestore(); remove.mockRestore();
  });

  it("recovers from a revision conflict with Load latest, keeping edits when the reload fails", async () => {
    const { read, view } = await loadedEditor();
    const save = vi.spyOn(api, "saveWakeSchedule").mockRejectedValue(new ApiError("Schedule changed; reload and retry.", 409, "wake_revision_conflict"));
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "My local edit." } });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("This replaces your unsaved changes."));
    read.mockRejectedValueOnce(new Error("Network unavailable."));
    await userEvent.click(screen.getByRole("button", { name: "Load latest" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load the latest version."));
    expect(screen.getByLabelText("Message")).toHaveValue("My local edit.");
    read.mockResolvedValueOnce({ schedule: { ...schedule, revision: 5, definition: { ...schedule.definition, message: "Newer text." } } });
    await userEvent.click(screen.getByRole("button", { name: "Load latest" }));
    await waitFor(() => expect(screen.getByLabelText("Message")).toHaveValue("Newer text."));
    expect(screen.queryByRole("alert")).toBeNull();
    save.mockResolvedValue({ schedule: { ...schedule, revision: 6 } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Second try." } });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith(thread.id, expect.objectContaining({ message: "Second try." }), 5));
    view.unmount(); read.mockRestore(); save.mockRestore();
  });

  it("recovers from a real 404 wake_schedule_not_found: Load latest keeps the draft and the next save creates", async () => {
    const { read, close, view } = await loadedEditor();
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Keep me." } });
    // A notice about a change elsewhere is already showing when Save fails.
    read.mockResolvedValueOnce({ schedule: { ...schedule, revision: 3 } });
    view.rerender(<WakeScheduleEditor thread={{ ...thread, wakeSchedule: { ...thread.wakeSchedule!, revision: 3 } }} onClose={close} />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Changed elsewhere"));
    const save = vi.spyOn(api, "saveWakeSchedule")
      .mockRejectedValueOnce(new ApiError("No schedule exists for this conversation.", 404, "wake_schedule_not_found"))
      .mockResolvedValueOnce({ schedule: { ...schedule, revision: 1 } });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("deleted elsewhere"));
    read.mockResolvedValueOnce({ schedule: null });
    await userEvent.click(screen.getByRole("button", { name: "Load latest" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "Schedule summary" })).toHaveTextContent("Not scheduled yet"));
    expect(screen.getByLabelText("Message")).toHaveValue("Keep me.");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith(thread.id, expect.objectContaining({ message: "Keep me." }), undefined));
    await waitFor(() => expect(close).toHaveBeenCalled());
    view.unmount(); read.mockRestore(); save.mockRestore();
  });

  it("recovers from a real 409 wake_schedule_exists: Load latest adopts it and the next save updates its revision", async () => {
    const { read, close, view } = await loadedEditor(null);
    const save = vi.spyOn(api, "saveWakeSchedule")
      .mockRejectedValueOnce(new ApiError("This conversation already has a schedule.", 409, "wake_schedule_exists"))
      .mockResolvedValueOnce({ schedule: { ...schedule, revision: 8 } });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(thread.id, expect.objectContaining({ kind: "once" }), undefined));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("created for this conversation elsewhere"));
    read.mockResolvedValueOnce({ schedule: { ...schedule, revision: 7 } });
    await userEvent.click(screen.getByRole("button", { name: "Load latest" }));
    await waitFor(() => expect(screen.getByLabelText("Message")).toHaveValue("Review the sample."));
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Merged by hand." } });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith(thread.id, expect.objectContaining({ message: "Merged by hand." }), 7));
    await waitFor(() => expect(close).toHaveBeenCalled());
    view.unmount(); read.mockRestore(); save.mockRestore();
  });

  it("offers Try again after a failed live refresh", async () => {
    const { read, view } = await loadedEditor();
    read.mockRejectedValueOnce(new Error("Network unavailable."));
    view.rerender(<WakeScheduleEditor thread={{ ...thread, wakeSchedule: { ...thread.wakeSchedule!, revision: 3 } }} onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load the latest version."));
    read.mockResolvedValueOnce({ schedule: { ...schedule, revision: 3, definition: { ...schedule.definition, message: "Fresh." } } });
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByLabelText("Message")).toHaveValue("Fresh."));
    expect(screen.queryByRole("alert")).toBeNull();
    view.unmount(); read.mockRestore();
  });

  it("ignores a read that started before Pause, keeping the paused result", async () => {
    const { read, view } = await loadedEditor();
    let late: (value: { schedule: typeof schedule }) => void = () => undefined;
    read.mockReturnValueOnce(new Promise((done) => { late = done; }));
    view.rerender(<WakeScheduleEditor thread={{ ...thread, wakeSchedule: { ...thread.wakeSchedule!, revision: 3 } }} onClose={() => undefined} />);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    const paused = { ...schedule, revision: 4, state: "paused" as const, nextFireAt: null };
    const pause = vi.spyOn(api, "setWakeState").mockResolvedValue({ schedule: paused });
    // The server now holds the paused schedule; any follow-up read returns it.
    read.mockResolvedValue({ schedule: paused });
    await userEvent.click(screen.getByRole("button", { name: "Pause schedule" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Resume schedule" })).toBeEnabled());
    await act(async () => { late({ schedule: { ...schedule, revision: 3 } }); });
    expect(screen.getByRole("button", { name: "Resume schedule" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Schedule summary" })).toHaveTextContent("Paused");
    view.unmount(); read.mockRestore(); pause.mockRestore();
  });

  it.each(["resolves", "rejects"] as const)("keeps the paused result when a live read started during Pause %s late", async (outcome) => {
    const { read, view } = await loadedEditor();
    let finishPause: (value: { schedule: typeof schedule }) => void = () => undefined;
    const pause = vi.spyOn(api, "setWakeState").mockReturnValue(new Promise((done) => { finishPause = done as never; }) as never);
    await userEvent.click(screen.getByRole("button", { name: "Pause schedule" }));
    await waitFor(() => expect(pause).toHaveBeenCalledTimes(1));
    let settleRead: { resolve: (value: { schedule: typeof schedule }) => void; reject: (cause: Error) => void } | undefined;
    read.mockReturnValueOnce(new Promise((resolve, reject) => { settleRead = { resolve, reject }; }));
    view.rerender(<WakeScheduleEditor thread={{ ...thread, wakeSchedule: { ...thread.wakeSchedule!, revision: 3 } }} onClose={() => undefined} />);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    const paused = { ...schedule, revision: 3, state: "paused" as const, nextFireAt: null };
    read.mockResolvedValue({ schedule: paused });
    await act(async () => { finishPause({ schedule: paused as never }); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Resume schedule" })).toBeEnabled());
    await act(async () => {
      if (outcome === "resolves") settleRead!.resolve({ schedule: { ...schedule, revision: 2 } });
      else settleRead!.reject(new Error("Stale network failure."));
    });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("region", { name: "Schedule summary" })).toHaveTextContent("Paused");
    expect(screen.getByRole("button", { name: "Resume schedule" })).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
    view.unmount(); read.mockRestore(); pause.mockRestore();
  });

  it.each(["save", "delete"] as const)("never lets a %s from a closed editor close a reopened one", async (action) => {
    const read = vi.spyOn(api, "wakeSchedule").mockResolvedValue({ schedule });
    let settle: () => void = () => undefined;
    const pending = new Promise<never>((done) => { settle = () => done(undefined as never); });
    const save = vi.spyOn(api, "saveWakeSchedule").mockReturnValue(pending);
    const remove = vi.spyOn(api, "deleteWakeSchedule").mockReturnValue(pending as never);
    const view = render(<Opener />);
    await userEvent.click(screen.getByRole("button", { name: "Conversation actions" }));
    await waitFor(() => expect(screen.getByLabelText("Message")).toBeEnabled());
    if (action === "save") {
      fireEvent.change(screen.getByLabelText("Message"), { target: { value: "First draft." } });
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    } else {
      await userEvent.click(screen.getByRole("button", { name: "Delete schedule" }));
      await userEvent.click(screen.getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    }
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Conversation actions" }));
    await waitFor(() => expect(screen.getByLabelText("Message")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Second draft." } });
    await act(async () => { settle(); await pending.catch(() => undefined); });
    await new Promise((done) => setTimeout(done, 50));
    expect(dialog()).toBeInTheDocument();
    expect(screen.getByLabelText("Message")).toHaveValue("Second draft.");
    view.unmount(); read.mockRestore(); save.mockRestore(); remove.mockRestore();
  });

  it("disables Pause while a delete is pending and refocuses the enabled row after a failed delete", async () => {
    const { read, view } = await loadedEditor();
    let fail: (cause: Error) => void = () => undefined;
    const remove = vi.spyOn(api, "deleteWakeSchedule").mockReturnValue(new Promise((_, reject) => { fail = reject; }));
    await userEvent.click(screen.getByRole("button", { name: "Delete schedule" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Pause schedule" })).toBeDisabled());
    await act(async () => { fail(new Error("The console is offline.")); });
    const row = screen.getByRole("button", { name: "Delete schedule" });
    await waitFor(() => expect(row).toBeEnabled());
    await waitFor(() => expect(row).toHaveFocus());
    expect(screen.getByRole("alert")).toHaveTextContent("The console is offline.");
    view.unmount(); read.mockRestore(); remove.mockRestore();
  });

  it("decides Resume for a paused one-off from the zone's wall clock, without a grace period", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const pausedOnce = { ...schedule, state: "paused" as const, nextFireAt: null,
      definition: { kind: "once" as const, timezone: "UTC", localAt: "2031-05-14T09:00" } };
    try {
      for (const [now, resumable] of [["2031-05-14T09:01:00Z", false], ["2031-05-14T09:59:00Z", false], ["2031-05-14T08:59:00Z", true]] as const) {
        vi.setSystemTime(new Date(now));
        const { read, view } = await loadedEditor(pausedOnce);
        if (resumable) expect(screen.getByRole("button", { name: "Resume schedule" })).toBeEnabled();
        else {
          expect(screen.queryByRole("button", { name: "Resume schedule" })).toBeNull();
          expect(screen.getByRole("region", { name: "Schedule summary" })).toHaveTextContent("its time has passed");
        }
        view.unmount(); read.mockRestore();
      }
    } finally { vi.useRealTimers(); }
  });

  it("links inline validation messages to their controls", async () => {
    const { read, view } = await loadedEditor();
    await userEvent.click(screen.getByRole("button", { name: "Add time" }));
    fireEvent.change(screen.getByLabelText("Time 3"), { target: { value: "09:00" } });
    expect(screen.getByLabelText("Time 3")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Time 3")).toHaveAccessibleDescription("Each time can be used only once.");
    fireEvent.click(screen.getByLabelText("Monday"));
    fireEvent.click(screen.getByLabelText("Wednesday"));
    expect(screen.getByLabelText("Friday")).toHaveAccessibleDescription("Pick at least one day.");
    await userEvent.click(screen.getByRole("button", { name: /^Timezone/u }));
    fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "Mars/Olympus" } });
    expect(screen.getByLabelText("Timezone")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Timezone")).toHaveAccessibleDescription(/valid timezone/u);
    await userEvent.click(screen.getByRole("radio", { name: "Once" }));
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "" } });
    expect(screen.getByLabelText("Date")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Date")).toHaveAccessibleDescription("Choose a date and a time.");
    view.unmount(); read.mockRestore();
  });

  it("adds distinct hourly times and gates Save on a real, valid change", async () => {
    const { read, close, view } = await loadedEditor();
    const save = vi.spyOn(api, "saveWakeSchedule").mockResolvedValue({ schedule: { ...schedule, revision: 3 } });
    const saveButton = screen.getByRole("button", { name: "Save" });
    expect(saveButton).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Add time" }));
    expect(screen.getByLabelText("Time 3")).toHaveValue("15:30");
    expect(saveButton).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Time 3"), { target: { value: "09:00" } });
    expect(saveButton).toBeDisabled();
    expect(screen.getByText("Each time can be used only once.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Remove time 3" }));
    expect(saveButton).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Friday"));
    await userEvent.click(saveButton);
    await waitFor(() => expect(save).toHaveBeenCalledWith(thread.id, expect.objectContaining({ days: [1, 3, 5], times: ["09:00", "14:30"] }), 2));
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    view.unmount(); read.mockRestore(); save.mockRestore();
  });

  it("counts the message in UTF-8 bytes, including emoji", async () => {
    const { read, view } = await loadedEditor();
    const message = screen.getByLabelText("Message");
    const save = screen.getByRole("button", { name: "Save" });
    fireEvent.change(message, { target: { value: "a".repeat(995) + "😀" } });
    expect(screen.getByText("999 / 1000 bytes")).toBeVisible();
    expect(save).toBeEnabled();
    fireEvent.change(message, { target: { value: "a".repeat(996) + "😀" } });
    expect(screen.getByText("1000 / 1000 bytes")).toBeVisible();
    expect(save).toBeEnabled();
    fireEvent.change(message, { target: { value: "a".repeat(997) + "😀" } });
    expect(screen.getByText("1001 / 1000 bytes")).toBeVisible();
    expect(screen.getByText(/1 bytes over the limit/u)).toBeVisible();
    expect(save).toBeDisabled();
    view.unmount(); read.mockRestore();
  });

  it("offers no Resume for a completed one-off and explains what Save does", async () => {
    const completed = { ...schedule, state: "completed" as const, nextFireAt: null, lastOutcome: "uncertain" as const,
      definition: { kind: "once" as const, timezone: "UTC", localAt: "2026-01-20T08:00" } };
    const { read, view } = await loadedEditor(completed);
    const summary = screen.getByRole("region", { name: "Schedule summary" });
    expect(summary).toHaveTextContent("Completed");
    expect(summary).toHaveTextContent("No further wake-ups");
    expect(summary).toHaveTextContent("isn't confirmed yet");
    expect(screen.queryByRole("button", { name: "Resume schedule" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2031-05-14" } });
    expect(summary).toHaveTextContent("Save turns this schedule on.");
    view.unmount(); read.mockRestore();
  });

  it("says an active one-off with no next time is waiting on the agent and conversation", async () => {
    const due = { ...schedule, nextFireAt: null, definition: { kind: "once" as const, timezone: "UTC", localAt: "2031-05-14T09:00" } };
    const { read, view } = await loadedEditor(due);
    expect(screen.getByRole("region", { name: "Schedule summary" }))
      .toHaveTextContent("Waiting to run when the agent and conversation are available.");
    view.unmount(); read.mockRestore();
  });

  it("disables Save and Resume for an archived conversation", async () => {
    const paused = { ...schedule, state: "paused" as const, nextFireAt: null };
    const { read, view } = await loadedEditor(paused, { ...thread, archivedAt: "2027-01-02T00:00:00.000Z" });
    expect(screen.getByRole("button", { name: "Resume schedule" })).toBeDisabled();
    expect(screen.getByRole("region", { name: "Schedule summary" })).toHaveTextContent("archived");
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Edited." } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    view.unmount(); read.mockRestore();
  });

  it("contains focus, blocks the background and returns focus to the persistent opener", async () => {
    const read = vi.spyOn(api, "wakeSchedule").mockResolvedValue({ schedule });
    const background = vi.fn();
    const view = render(<><Opener /><button type="button" onClick={background}>Outside</button></>);
    const opener = screen.getByRole("button", { name: "Conversation actions" });
    await userEvent.click(opener);
    await waitFor(() => expect(dialog()).toHaveFocus());
    await waitFor(() => expect(screen.getByLabelText("Message")).toBeEnabled());
    for (let step = 0; step < 40; step += 1) {
      await userEvent.tab();
      expect(dialog().contains(document.activeElement)).toBe(true);
    }
    for (let step = 0; step < 5; step += 1) {
      await userEvent.tab({ shift: true });
      expect(dialog().contains(document.activeElement)).toBe(true);
    }
    // What a pointer at the background button actually hits is the modal's
    // backdrop; pressing there dismisses the editor and never reaches the button.
    const outside = screen.getByText("Outside");
    const box = outside.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const hit = document.elementFromPoint(x, y);
    expect(hit).not.toBeNull();
    expect(hit!.closest(".wake-schedule-backdrop")).not.toBeNull();
    expect(outside.contains(hit)).toBe(false);
    await userEvent.click(hit!, { position: { x, y } });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(background).not.toHaveBeenCalled();
    await waitFor(() => expect(opener).toHaveFocus());
    view.unmount(); read.mockRestore();
  });

  it.each([[320, 640], [360, 740], [390, 844], [844, 390]] as const)("keeps once and weekly controls (several AM/PM times, remove buttons, long zone) inside the sheet at %ix%i", async (width, height) => {
    await page.viewport(width, height);
    const { read, view } = await loadedEditor(null);
    // Geometry only: native text rendering itself is checked in the WebKit and Chromium screenshots.
    const within = () => {
      const box = dialog().getBoundingClientRect();
      for (const control of dialog().querySelectorAll<HTMLElement>("input, textarea, button")) {
        if (control.closest(".sr-only") || getComputedStyle(control).opacity === "0") continue;
        const rect = control.getBoundingClientRect();
        expect(rect.left).toBeGreaterThanOrEqual(box.left - 0.5);
        expect(rect.right).toBeLessThanOrEqual(box.right + 0.5);
      }
      for (const input of dialog().querySelectorAll<HTMLInputElement>('input[type="date"], input[type="time"]')) {
        const holder = input.parentElement!.getBoundingClientRect();
        expect(input.getBoundingClientRect().right).toBeLessThanOrEqual(holder.right + 0.5);
        expect(input.scrollWidth).toBeLessThanOrEqual(input.clientWidth + 1);
      }
    };
    within();
    for (const input of [screen.getByLabelText("Date"), screen.getByLabelText("Time")]) {
      expect(input.getBoundingClientRect().width).toBeGreaterThan(90);
      expect((input as HTMLInputElement).value).not.toBe("");
    }
    await userEvent.click(screen.getByRole("radio", { name: "Weekly" }));
    for (const value of ["07:30", "12:00", "18:15", "23:45"]) {
      await userEvent.click(screen.getByRole("button", { name: "Add time" }));
      fireEvent.change(screen.getByLabelText(`Time ${String(screen.getAllByLabelText(/^Time \d$/u).length)}`), { target: { value } });
    }
    expect(screen.getAllByRole("button", { name: /^Remove time \d$/u })).toHaveLength(5);
    await userEvent.click(screen.getByRole("button", { name: /^Timezone/u }));
    fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "America/Argentina/ComodRivadavia" } });
    within();
    for (const day of ["Monday", "Sunday"]) expect(screen.getByLabelText(day).getBoundingClientRect().width).toBeGreaterThanOrEqual(40);
    for (const index of [1, 2, 3, 4, 5]) {
      const time = screen.getByLabelText(`Time ${String(index)}`);
      const remove = screen.getByRole("button", { name: `Remove time ${String(index)}` });
      expect(time.getBoundingClientRect().width).toBeGreaterThan(70);
      expect(time.getBoundingClientRect().right).toBeLessThanOrEqual(remove.getBoundingClientRect().left + 0.5);
    }
    const zoneName = dialog().querySelector<HTMLElement>(".wake-timezone-name")!;
    expect(zoneName).toHaveTextContent("America/Argentina/ComodRivadavia");
    expect(zoneName.scrollWidth).toBeLessThanOrEqual(zoneName.clientWidth + 1);
    view.unmount(); read.mockRestore();
    await page.viewport(1440, 1000);
  });

  it("scrolls a tall schedule to a fully visible delete row on a phone", async () => {
    await page.viewport(390, 700);
    const eight = { ...schedule, definition: { ...schedule.definition, days: [0, 1, 2, 3, 4, 5, 6],
      times: ["06:00", "08:00", "10:00", "12:00", "14:00", "16:00", "18:00", "20:00"] } };
    const { read, view } = await loadedEditor(eight);
    const body = dialog().querySelector<HTMLElement>(".wake-body")!;
    expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
    body.scrollTop = body.scrollHeight;
    await waitFor(() => expect(dialog()).toHaveAttribute("data-scrolled"));
    const row = screen.getByRole("button", { name: "Delete schedule" }).getBoundingClientRect();
    const group = screen.getByRole("button", { name: "Delete schedule" }).parentElement!.getBoundingClientRect();
    expect(group.height).toBeGreaterThanOrEqual(row.height);
    expect(row.bottom).toBeLessThanOrEqual(body.getBoundingClientRect().bottom);
    view.unmount(); read.mockRestore();
    await page.viewport(1440, 1000);
  });

  it.each([[1280, 800, "desktop"], [390, 844, "mobile"]] as const)("shows editor, summary/list indicator and retained empty answer at %ipx (%s)", async (width, height, name) => {
    await page.viewport(width, height);
    const read = vi.spyOn(api, "wakeSchedule").mockResolvedValue({ schedule });
    const editor = render(<WakeScheduleEditor thread={thread} onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByLabelText("Monday")).toBeChecked());
    expect(screen.getByLabelText("Wednesday")).toBeChecked();
    expect(screen.getByLabelText("Time 2")).toHaveValue("14:30");
    await waitFor(() => expect(dialog()).toHaveFocus());
    await capture(`${name}-weekly-schedule-editor`);
    if (name === "desktop") {
      try {
        await commands.emulateColorScheme("dark");
        await capture("desktop-weekly-schedule-editor-dark");
      } finally { await commands.emulateColorScheme(null); }
    }
    editor.unmount();
    read.mockRestore();

    const controls = render(<div className="chat-panel" style={{ width: Math.min(width - 24, 700), margin: "1rem auto" }}>
      <header className="chat-header" style={width < 500 ? { flexDirection: "column", alignItems: "stretch" } : {}}><strong>Sample conversation</strong><div className="conversation-menu-popup">
        <div className="conversation-menu-item is-wake"><span className="wake-menu-copy"><span>Edit wake-up schedule</span>
          <WakeScheduleStatus thread={thread} /></span></div>
      </div></header>
      <div className="thread-item is-conversation"><div className="thread-trigger"><span className="thread-title">Sample conversation</span>
        <span className="wake-indicator" role="img" aria-label="Active scheduled wake-up"><Icon name="clock" size={14} /></span></div></div>
    </div>);
    expect(screen.getByLabelText("Wake-up schedule status")).toHaveTextContent(/Weekly · next/u);
    expect(screen.getByLabelText("Active scheduled wake-up")).toBeVisible();
    await capture(`${name}-active-schedule-header-and-list`);
    controls.unmount();

    const message: WebMessage = { id: "scheduled-message", threadId: thread.id, role: "assistant",
      status: "complete", createdAt: "2027-01-04T09:00:00.000Z", updatedAt: "2027-01-04T09:00:00.000Z",
      attachments: [], parts: [{ type: "scheduled-wake", occurrenceId: "sample-occurrence",
        scheduledAt: "2027-01-04T09:00:00.000Z", firedAt: "2027-01-04T09:00:00.000Z", timezone: "UTC", message: "Review the sample." }] };
    const transcript = render(<div style={{ width: Math.min(width - 24, 700), margin: "1rem auto" }}><Transcript message={message} /></div>);
    expect(screen.getByLabelText("Scheduled wake-up")).toHaveTextContent("Review the sample.");
    await capture(`${name}-fired-scheduled-wake-transcript`);
    for (const status of ["running", "failed"] as const) {
      transcript.rerender(<div style={{ width: Math.min(width - 24, 700), margin: "1rem auto" }}><Transcript message={{ ...message, status }} /></div>);
      expect(screen.getByLabelText("Scheduled wake-up")).toHaveTextContent("Review the sample.");
    }
    await page.viewport(1440, 1000);
  });
});

describe("compact-first wake option", () => {
  it("persists the checkbox, reloads it, and captures mobile and desktop evidence", async () => {
    const read = vi.spyOn(api, "wakeSchedule").mockResolvedValue({ schedule });
    const compacted = { ...schedule, definition: { ...schedule.definition, compactFirst: true } };
    const save = vi.spyOn(api, "saveWakeSchedule").mockResolvedValue({ schedule: compacted });
    const view = render(<WakeScheduleEditor supportsManualCompaction thread={thread} onClose={() => undefined} />);
    const checkbox = screen.getByRole("checkbox", { name: "Compact conversation first" });
    await waitFor(() => expect(checkbox).toBeEnabled());
    expect(checkbox).not.toBeChecked();
    await userEvent.click(checkbox);
    expect(screen.getByRole("region", { name: "Schedule summary" })).toHaveTextContent("Compact conversation first");
    await page.viewport(1440, 1000);
    await capture("compact-first-desktop");
    await page.viewport(390, 844);
    await capture("compact-first-mobile");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(thread.id, expect.objectContaining({ compactFirst: true }), schedule.revision));
    view.unmount();
    read.mockResolvedValue({ schedule: compacted });
    const reopened = render(<WakeScheduleEditor supportsManualCompaction thread={thread} onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Compact conversation first" })).toBeChecked());
    reopened.unmount(); read.mockRestore(); save.mockRestore();
    await page.viewport(1440, 1000);
  });

  it("explains and disables unsupported compaction without promising it", async () => {
    const { read, view } = await loadedEditor();
    expect(screen.getByRole("checkbox", { name: "Compact conversation first" })).toBeDisabled();
    expect(screen.getByText(/This agent does not support manual compaction/u)).toBeVisible();
    view.unmount(); read.mockRestore();
  });
});
