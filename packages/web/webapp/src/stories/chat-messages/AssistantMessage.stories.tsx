import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ThreadMessageLike } from "@assistant-ui/react";
import { AssistantMessage } from "../../components/Messages";
import { ManualCompactionMarker } from "../../components/ManualCompactionMarker";
import { gardenThread } from "../fixtures";
import { sampleMessages } from "../runtime";
import { Transcript } from "../transcript";
export default { title: "Chat & Messages/AssistantMessage", component: AssistantMessage, tags: ["autodocs"] } satisfies Meta<typeof AssistantMessage>;
type Story = StoryObj<typeof AssistantMessage>;
export const Conversation: Story = { render: () => <Transcript /> };
export const User: Story = { render: () => <Transcript messages={[sampleMessages[0]!]} /> };
export const AssistantMarkdown: Story = { render: () => <Transcript messages={[sampleMessages[1]!]} /> };
export const System: Story = { render: () => <Transcript messages={[sampleMessages[2]!]} /> };
export const LongMarkdown: Story = { render: () => <Transcript messages={[sampleMessages[0]!, { role: "assistant", content: Array.from({ length: 8 }, (_, index) => `## Section ${String(index + 1)}\n\n${sampleMessages[1]!.content}`).join("\n\n") }]} /> };
export const Mobile: Story = { render: () => <Transcript />, globals: { viewport: { value: "phone" } } };

const compaction = (status: string, trigger: string, extras: Record<string, unknown> = {}) => ({
  type: "data-context-compaction" as const,
  data: { kind: "context_compaction", data: { status, trigger, ...extras } },
});
const compactionMessages = (event: ReturnType<typeof compaction>, status: "complete" | "running" = "complete"): ThreadMessageLike[] => [
  { role: "user", content: "Can you update the fictional garden plan?" },
  { role: "assistant", status: status === "running" ? { type: "running" } : { type: "complete", reason: "stop" }, content: [
    { type: "text", text: "The garden plan is ready." }, event,
  ] },
];
export const ManualCompacted: Story = { render: () => <Transcript messages={compactionMessages(compaction("succeeded", "manual", {
  tokensBefore: 183_400, tokensAfter: 41_300,
}))} /> };
export const AutomaticRunning: Story = { render: () => <Transcript messages={compactionMessages(compaction("running", "automatic"), "running")} /> };
export const AutomaticFailed: Story = { render: () => <Transcript messages={compactionMessages(compaction("failed", "overflow"))} /> };
export const ManualSkipped: Story = { render: () => <Transcript messages={compactionMessages(compaction("skipped", "manual", { reason: "nothing_to_compact" }))} /> };
export const ManualCompactedPhone: Story = { ...ManualCompacted, globals: { viewport: { value: "phone" } } };
export const ManualCompactionPending: Story = { render: () => <>
  <Transcript messages={compactionMessages(compaction("succeeded", "automatic"))} />
  <ManualCompactionMarker thread={{ ...gardenThread, compaction: { status: "running", trigger: "manual", startedAt: "2026-09-28T10:00:00Z" } }} detail={null} />
</> };
