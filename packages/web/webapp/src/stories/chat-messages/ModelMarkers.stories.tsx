import type { Meta, StoryObj } from "@storybook/react-vite";
import { ModelMarkers } from "../../components/ModelMarkers";

export default { title: "Chat & Messages/ModelMarkers", component: ModelMarkers, tags: ["autodocs"] } satisfies Meta<typeof ModelMarkers>;
type Story = StoryObj<typeof ModelMarkers>;
const changed = { type: "conversation-marker" as const, kind: "model" as const, before: { model: "atlas/standard", effort: "high" }, after: { model: "grove/fast", effort: "medium" }, at: "2026-01-15T10:00:00Z" };
export const ModelChanged: Story = { args: { transitions: [changed] } };
export const EffortOnly: Story = { args: { transitions: [{ ...changed, after: { model: "atlas/standard", effort: "low" } }] } };
export const Empty: Story = { args: { transitions: [] } };
