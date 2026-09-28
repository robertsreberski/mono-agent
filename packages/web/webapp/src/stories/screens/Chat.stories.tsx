import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent } from "storybook/test";
import { Chat } from "../../components/Chat";
import { Dashboard } from "../../components/dashboard/Dashboard";
import { StoryRuntime, sampleMessages } from "../runtime";
import type { ThreadMessageLike } from "@assistant-ui/react";
import { gardenThread, runningThread } from "../fixtures";
import { storyStore } from "../store";
import { useEffect } from "react";
import { RecentFixtures } from "../screen-fixtures";
import { waitForOverlay } from "../overlay-play";
import { installWakeStoryApi, wakeFixtures, wakeSummary } from "../wake-api";

const streamingMessages: readonly ThreadMessageLike[] = [sampleMessages[0]!, {
  role: "assistant", status: { type: "running" }, content: [
    { type: "text", text: "Drafting the first planting beds for Morgan..." },
    { type: "tool-call", toolCallId: "read-garden-outline", toolName: "Read", args: { file_path: "garden/outline.md" } },
  ],
}];

function ConsoleShell({ children, phone = false, streaming = false, compacting = false, wake = false }: { readonly children: React.ReactNode; readonly phone?: boolean; readonly streaming?: boolean; readonly compacting?: boolean; readonly wake?: boolean }) {
  if (streaming) Object.assign(storyStore, { selectedThread: { ...runningThread, title: gardenThread.title }, selectedThreadId: runningThread.id });
  if (compacting) Object.assign(storyStore, { selectedThread: { ...gardenThread, compaction: { status: "running", trigger: "manual", startedAt: "2026-09-28T10:00:00Z" } }, selectedThreadId: gardenThread.id });
  if (wake) Object.assign(storyStore, { selectedThread: { ...gardenThread, wakeSchedule: wakeSummary(wakeFixtures.activeWeekly) }, selectedThreadId: gardenThread.id });
  useEffect(() => () => { if (streaming || compacting || wake) Object.assign(storyStore, { selectedThread: gardenThread, selectedThreadId: gardenThread.id }); }, [streaming, compacting, wake]);
  return <StoryRuntime messages={streaming ? streamingMessages : undefined}><div className="app-shell">
    <div className="dashboard-panel" role="navigation" aria-label="Dashboard" aria-hidden={phone || undefined}>
      <Dashboard highlightSelected={!phone} /><RecentFixtures />
    </div>
    <div className="chat-region is-open">{children}</div>
  </div></StoryRuntime>;
}
export default {
  title: "Screens/Chat", component: Chat, tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  decorators: [(Story, context) => <ConsoleShell phone={context.globals.viewport?.value === "phone"} streaming={context.parameters.streaming === true} compacting={context.parameters.compacting === true} wake={context.parameters.wake === true}><Story /></ConsoleShell>],
} satisfies Meta<typeof Chat>;
type Story = StoryObj<typeof Chat>;
export const Desktop: Story = { args: { onBack: () => {} } };
export const Phone: Story = { args: { onBack: () => {} }, globals: { viewport: { value: "phone" } } };
export const Streaming: Story = { args: { onBack: () => {} }, parameters: { streaming: true } };
export const StreamingPhone: Story = { args: { onBack: () => {} }, parameters: { streaming: true }, globals: { viewport: { value: "phone" } } };
export const ManualCompactingClosed: Story = { args: Desktop.args, parameters: { compacting: true } };
export const ManualCompactingPhone: Story = { args: Phone.args, parameters: { compacting: true }, globals: Phone.globals };
const openActions: NonNullable<Story["play"]> = async ({ canvasElement }) => {
  const button = canvasElement.querySelector<HTMLElement>('button[aria-label="Conversation actions"]');
  if (!button) throw new Error("Conversation actions trigger missing");
  await userEvent.click(button);
  await waitForOverlay(canvasElement, '.conversation-menu-popup[aria-label="Conversation actions"]');
};
export const ActionsOpen: Story = { args: Desktop.args, play: openActions };
export const ActionsPhone: Story = { args: Phone.args, globals: Phone.globals, play: openActions };
export const ProjectMenuOpen: Story = { args: Desktop.args, play: async (context) => {
  await openActions(context);
  const submenu = context.canvasElement.ownerDocument.querySelector<HTMLElement>('.conversation-menu-popup[aria-label="Conversation actions"] .conversation-menu-item');
  if (!submenu) throw new Error("Project submenu trigger missing");
  await userEvent.click(submenu);
  await waitForOverlay(context.canvasElement, '.conversation-menu-popup[aria-label="Move to project"]');
} };
// A conversation with an active weekly wake-up: the menu row's status line,
// then the editor opened from it over the whole console.
const wakeServer = () => installWakeStoryApi({ schedule: { ...wakeFixtures.activeWeekly, threadId: gardenThread.id } });
const openWakeEditor: NonNullable<Story["play"]> = async (context) => {
  await openActions(context);
  const item = [...context.canvasElement.ownerDocument.querySelectorAll<HTMLElement>(".conversation-menu-item.is-wake")][0];
  if (!item) throw new Error("Wake-up menu item missing");
  await userEvent.click(item);
  await waitForOverlay(context.canvasElement, ".wake-schedule-sheet");
};
export const WakeMenu: Story = { args: Desktop.args, parameters: { wake: true }, beforeEach: wakeServer, play: openActions };
export const WakeMenuPhone: Story = { args: Phone.args, globals: Phone.globals, parameters: { wake: true }, beforeEach: wakeServer, play: openActions };
export const WakeEditorOpen: Story = { args: Desktop.args, parameters: { wake: true }, beforeEach: wakeServer, play: openWakeEditor };
export const WakeEditorOpenPhone: Story = { args: Phone.args, globals: Phone.globals, parameters: { wake: true }, beforeEach: wakeServer, play: openWakeEditor };
