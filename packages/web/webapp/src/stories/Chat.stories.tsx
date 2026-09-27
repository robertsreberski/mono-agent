import type { Meta, StoryObj } from "@storybook/react-vite";
import { AssistantRuntimeProvider, useLocalRuntime } from "@assistant-ui/react";
import { Composer } from "../components/Composer";
import { Chat, ConnectionBanner } from "../components/Chat";
import { ReasoningRoot, ReasoningTrigger, ReasoningContent, ReasoningText } from "../components/assistant-ui/Reasoning";
import { ModelMarkers } from "../components/ModelMarkers";
import { ProjectMarkers } from "../components/project/ProjectIdentity";
import { ReplyFailurePart } from "../components/ReplyParts";
import { SubagentPart } from "../components/Subagent";

function LocalPreview({ children }: { children: React.ReactNode }) {
  const runtime = useLocalRuntime({ run: async () => ({ content: [{ type: "text", text: "Garden planner is ready." }] }) });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
function Conversation() {
  return <LocalPreview><div style={{ width: 700, maxWidth: "100%", minHeight: 680, background: "var(--surface)", border: "1px solid var(--line)" }}><Chat onBack={() => {}} /></div></LocalPreview>;
}
export default { title: "Chat & Messages/Conversation", component: Conversation, tags: ["autodocs"] } satisfies Meta<typeof Conversation>;
export const Screen: StoryObj<typeof Conversation> = {};
export const Mobile: StoryObj<typeof Conversation> = { globals: { viewport: { value: "phone" } } };
export const ComposerInput: StoryObj<typeof Conversation> = { render: () => <LocalPreview><Composer /></LocalPreview> };
export const Transcript: StoryObj<typeof Conversation> = { render: () => <LocalPreview><Chat onBack={() => {}} /></LocalPreview> };
export const Reasoning: StoryObj<typeof Conversation> = { render: () => <LocalPreview><ReasoningRoot><ReasoningTrigger /><ReasoningContent><ReasoningText>Exploring planting options.</ReasoningText></ReasoningContent></ReasoningRoot></LocalPreview> };
export const EmptyExtras: StoryObj<typeof Conversation> = { render: () => <LocalPreview><p>Empty transcript metadata</p><ModelMarkers /><ProjectMarkers /><ConnectionBanner connection="reconnecting" /></LocalPreview> };
export const ErrorPart: StoryObj<typeof Conversation> = { render: () => <><ReplyFailurePart {...({ data: { type: "reply-failure", message: "Example failure" } } as Parameters<typeof ReplyFailurePart>[0])} /><SubagentPart {...({ data: { type: "subagent" } } as Parameters<typeof SubagentPart>[0])} /></> };
