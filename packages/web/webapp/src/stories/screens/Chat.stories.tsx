import type { Meta, StoryObj } from "@storybook/react-vite";
import { Chat } from "../../components/Chat";
import { Dashboard } from "../../components/dashboard/Dashboard";
import { StoryRuntime, sampleMessages } from "../runtime";
import type { ThreadMessageLike } from "@assistant-ui/react";
import { gardenThread, runningThread } from "../fixtures";
import { storyStore } from "../store";
import { useEffect } from "react";
import { RecentFixtures } from "../screen-fixtures";

const streamingMessages: readonly ThreadMessageLike[] = [sampleMessages[0]!, {
  role: "assistant", status: { type: "running" }, content: [
    { type: "text", text: "Drafting the first planting beds for Morgan..." },
    { type: "tool-call", toolCallId: "read-garden-outline", toolName: "Read", args: { file_path: "garden/outline.md" } },
  ],
}];

function ConsoleShell({ children, phone = false, streaming = false }: { readonly children: React.ReactNode; readonly phone?: boolean; readonly streaming?: boolean }) {
  if (streaming) Object.assign(storyStore, { selectedThread: { ...runningThread, title: gardenThread.title }, selectedThreadId: runningThread.id });
  useEffect(() => () => { if (streaming) Object.assign(storyStore, { selectedThread: gardenThread, selectedThreadId: gardenThread.id }); }, [streaming]);
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
  decorators: [(Story, context) => <ConsoleShell phone={context.globals.viewport?.value === "phone"} streaming={context.parameters.streaming === true}><Story /></ConsoleShell>],
} satisfies Meta<typeof Chat>;
type Story = StoryObj<typeof Chat>;
export const Desktop: Story = { args: { onBack: () => {} } };
export const Phone: Story = { args: { onBack: () => {} }, globals: { viewport: { value: "phone" } } };
export const Streaming: Story = { args: { onBack: () => {} }, parameters: { streaming: true } };
export const StreamingPhone: Story = { args: { onBack: () => {} }, parameters: { streaming: true }, globals: { viewport: { value: "phone" } } };
