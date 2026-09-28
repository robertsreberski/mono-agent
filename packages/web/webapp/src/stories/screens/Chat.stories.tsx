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
import { ProcessJobPresentationProvider } from "../../process-job-presentation";
import * as J from "../job-fixtures";

const streamingMessages: readonly ThreadMessageLike[] = [sampleMessages[0]!, {
  role: "assistant", status: { type: "running" }, content: [
    { type: "text", text: "Drafting the first planting beds for Morgan..." },
    { type: "tool-call", toolCallId: "read-garden-outline", toolName: "Read", args: { file_path: "garden/outline.md" } },
  ],
}];

function ConsoleShell({ children, phone = false, streaming = false, compacting = false, jobs }: { readonly children: React.ReactNode; readonly phone?: boolean; readonly streaming?: boolean; readonly compacting?: boolean; readonly jobs?: readonly J.Job[] }) {
  if (streaming) Object.assign(storyStore, { selectedThread: { ...runningThread, title: gardenThread.title }, selectedThreadId: runningThread.id });
  if (compacting) Object.assign(storyStore, { selectedThread: { ...gardenThread, compaction: { status: "running", trigger: "manual", startedAt: "2026-09-28T10:00:00Z" } }, selectedThreadId: gardenThread.id });
  useEffect(() => () => { if (streaming || compacting) Object.assign(storyStore, { selectedThread: gardenThread, selectedThreadId: gardenThread.id }); }, [streaming, compacting]);
  return <StoryRuntime messages={streaming ? streamingMessages : undefined}><div className="app-shell">
    <div className="dashboard-panel" role="navigation" aria-label="Dashboard" aria-hidden={phone || undefined}>
      <Dashboard highlightSelected={!phone} /><RecentFixtures />
    </div>
    <div className="chat-region is-open">{jobs === undefined ? children : (
      // The real app mounts this provider in its runtime; here it carries fictional jobs.
      <ProcessJobPresentationProvider threadId={gardenThread.id} messages={[]} jobs={jobs.map(J.entry)} historyIsBounded={false}>{children}</ProcessJobPresentationProvider>
    )}</div>
  </div></StoryRuntime>;
}
export default {
  title: "Screens/Chat", component: Chat, tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  decorators: [(Story, context) => <ConsoleShell phone={context.globals.viewport?.value === "phone"} streaming={context.parameters.streaming === true} compacting={context.parameters.compacting === true} jobs={context.parameters.jobs as readonly J.Job[] | undefined}><Story /></ConsoleShell>],
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
// then the editor opened from it over the whole console. The selected thread
// and the scripted wake API are both installed by the story's own lifecycle
// and restored by its cleanup; the stories stay out of the inline Docs page.
const wakeSchedule = { ...wakeFixtures.activeWeekly, threadId: gardenThread.id };
const wakeSetup = () => {
  const previous = { selectedThread: storyStore.selectedThread, selectedThreadId: storyStore.selectedThreadId };
  Object.assign(storyStore, { selectedThread: { ...gardenThread, wakeSchedule: wakeSummary(wakeSchedule) }, selectedThreadId: gardenThread.id });
  const uninstall = installWakeStoryApi({ schedule: wakeSchedule, nextFireAt: wakeSchedule.nextFireAt });
  return () => { uninstall(); Object.assign(storyStore, previous); };
};
const openWakeEditor: NonNullable<Story["play"]> = async (context) => {
  await openActions(context);
  const item = [...context.canvasElement.ownerDocument.querySelectorAll<HTMLElement>(".conversation-menu-item.is-wake")][0];
  if (!item) throw new Error("Wake-up menu item missing");
  await userEvent.click(item);
  await waitForOverlay(context.canvasElement, ".wake-schedule-sheet");
};
const wakeStory = { tags: ["!autodocs"], beforeEach: wakeSetup } satisfies Partial<Story>;
export const WakeMenu: Story = { ...wakeStory, args: Desktop.args, play: openActions };
export const WakeMenuPhone: Story = { ...wakeStory, args: Phone.args, globals: Phone.globals, play: openActions };
export const WakeEditorOpen: Story = { ...wakeStory, args: Desktop.args, play: openWakeEditor };
export const WakeEditorOpenPhone: Story = { ...wakeStory, args: Phone.args, globals: Phone.globals, play: openWakeEditor };

// The background-jobs shelf in its real slot above the composer.
const openShelf: NonNullable<Story["play"]> = async ({ canvasElement }) => {
  const toggle = canvasElement.querySelector<HTMLElement>(".process-job-stack-toggle");
  if (!toggle) throw new Error("Background jobs shelf missing");
  await userEvent.click(toggle);
};
const openRow: NonNullable<Story["play"]> = async (context) => {
  await openShelf(context);
  const summary = context.canvasElement.querySelector<HTMLElement>(".process-job-stack-item:not([hidden]) .process-job-card[data-state='running'] > summary");
  if (!summary) throw new Error("Running job row missing");
  await userEvent.click(summary);
};
export const WithBackgroundJobs: Story = { args: Desktop.args, parameters: { jobs: J.busyThread } };
export const WithBackgroundJobsOpen: Story = { args: Desktop.args, parameters: { jobs: J.busyThread }, play: openShelf };
export const WithBackgroundJobsRow: Story = { args: Desktop.args, parameters: { jobs: J.busyThread }, play: openRow };
export const WithBackgroundJobsIdle: Story = { args: Desktop.args, parameters: { jobs: J.idleThread } };
export const WithBackgroundJobsPhone: Story = { args: Phone.args, globals: Phone.globals, parameters: { jobs: J.busyThread } };
export const WithBackgroundJobsPhoneOpen: Story = { args: Phone.args, globals: Phone.globals, parameters: { jobs: J.busyThread }, play: openShelf };
