import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime } from "@assistant-ui/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { commands, page } from "@vitest/browser/context";
import { describe, expect, it, vi } from "vitest";
import { api } from "../api";
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
  id: "fictional-thread", sourceId: "fictional-agent", title: "Sample conversation",
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

describe("scheduled wake UI in Chromium", () => {
  it("preserves a dirty draft across a live summary revision, reports a stale save and closes on Escape", async () => {
    const read = vi.spyOn(api, "wakeSchedule").mockResolvedValueOnce({ schedule })
      .mockResolvedValueOnce({ schedule: { ...schedule, revision: 3,
        definition: { ...schedule.definition, message: "Changed elsewhere." } } });
    const save = vi.spyOn(api, "saveWakeSchedule").mockRejectedValue(new Error("Schedule changed; reload and retry."));
    const close = vi.fn();
    const editor = render(<WakeScheduleEditor thread={thread} onClose={close} />);
    await waitFor(() => expect(screen.getByLabelText("Optional message")).toHaveValue("Review the sample."));
    fireEvent.change(screen.getByLabelText("Optional message"), { target: { value: "Local draft." } });
    editor.rerender(<WakeScheduleEditor thread={{ ...thread, wakeSchedule: { ...thread.wakeSchedule!, revision: 3 } }} onClose={close} />);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Optional message")).toHaveValue("Local draft.");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Schedule changed/u));
    expect(save).toHaveBeenCalledWith(thread.id, expect.objectContaining({ message: "Local draft." }), 2);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
    editor.unmount(); read.mockRestore(); save.mockRestore();
  });
  it.each([[1280, 800, "desktop"], [390, 844, "mobile"]] as const)("shows editor, summary/list indicator and retained empty answer at %ipx (%s)", async (width, height, name) => {
    await page.viewport(width, height);
    const read = vi.spyOn(api, "wakeSchedule").mockResolvedValue({ schedule });
    const editor = render(<WakeScheduleEditor thread={thread} onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByLabelText("Monday")).toBeChecked());
    expect(screen.getByLabelText("Wednesday")).toBeChecked();
    expect(screen.getByLabelText("Time 2")).toHaveValue("14:30");
    expect(screen.getByRole("dialog", { name: "Scheduled wake-up" })).toHaveFocus();
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
    expect(screen.getByLabelText("Wake-up schedule status")).toHaveTextContent(/active · next/u);
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
  });
});
