import type { Meta, StoryObj } from "@storybook/react-vite";
import { SubagentPart } from "../../components/Subagent";
import type { MessagePart } from "../../types";
const delegation = { type: "subagent", toolCallId: "delegation-1", name: "researcher", label: "Outline the garden", status: "complete", executionMs: 12000, args: { prompt: "Outline a fictional garden plan" }, result: "Three planting zones proposed", calls: [
  { toolCallId: "read-1", toolName: "Read", args: { file_path: "garden/outline.md" }, result: "Garden outline", status: "complete" },
  { toolCallId: "grep-1", toolName: "Grep", args: { pattern: "plant" }, result: "Sage", status: "complete" },
] } satisfies Extract<MessagePart, { type: "subagent" }>;
export default { title: "Activity & Jobs/SubagentPart", component: SubagentPart, tags: ["autodocs"] } satisfies Meta<typeof SubagentPart>;
type Story = StoryObj<typeof SubagentPart>;
export const Completed: Story = { args: { data: delegation } as Parameters<typeof SubagentPart>[0] };
export const Running: Story = { args: { data: { ...delegation, status: "running", result: undefined, calls: delegation.calls.slice(0, 1) } } as Parameters<typeof SubagentPart>[0] };
export const Failed: Story = { args: { data: { ...delegation, status: "failed", result: "Example task failed" } } as Parameters<typeof SubagentPart>[0] };
export const Mobile: Story = { args: { data: delegation } as Parameters<typeof SubagentPart>[0], globals: { viewport: { value: "phone" } } };
