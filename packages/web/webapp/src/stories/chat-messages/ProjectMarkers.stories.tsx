import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProjectMarkers } from "../../components/project/ProjectIdentity";

export default { title: "Chat & Messages/ProjectMarkers", component: ProjectMarkers, tags: ["autodocs"] } satisfies Meta<typeof ProjectMarkers>;
type Story = StoryObj<typeof ProjectMarkers>;
const identity = { id: "garden", name: "Garden planner", color: "blue" as const };
const base = { type: "conversation-marker" as const, kind: "project" as const, at: "2026-01-15T10:00:00Z" };
export const Joined: Story = { args: { transitions: [{ ...base, before: null, after: identity }] } };
export const Left: Story = { args: { transitions: [{ ...base, before: identity, after: null }] } };
export const Moved: Story = { args: { transitions: [{ ...base, before: identity, after: { id: "seed", name: "Seed catalog", color: "amber" } }] } };
export const Empty: Story = { args: { transitions: [] } };
