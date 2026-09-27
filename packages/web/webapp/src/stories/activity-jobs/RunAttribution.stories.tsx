import type { Meta, StoryObj } from "@storybook/react-vite";
import { RunAttribution } from "../../components/RunAttribution";
import { fallbackAttribution } from "../fixtures";
export default { title: "Activity & Jobs/RunAttribution", component: RunAttribution, tags: ["autodocs"] } satisfies Meta<typeof RunAttribution>;
type Story = StoryObj<typeof RunAttribution>;
export const Fallback: Story = { args: { attribution: fallbackAttribution, status: "complete" } };
export const Running: Story = { args: { attribution: { ...fallbackAttribution, disposition: "requested", attempted: fallbackAttribution.requested, transitions: [] }, status: "running" } };
