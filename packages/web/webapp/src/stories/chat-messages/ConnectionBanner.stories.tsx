import type { Meta, StoryObj } from "@storybook/react-vite";
import { ConnectionBanner } from "../../components/Chat";

export default { title: "Chat & Messages/ConnectionBanner", component: ConnectionBanner, tags: ["autodocs"] } satisfies Meta<typeof ConnectionBanner>;
type Story = StoryObj<typeof ConnectionBanner>;
export const Live: Story = { args: { connection: "live" } };
export const Connecting: Story = { args: { connection: "connecting" } };
export const Offline: Story = { args: { connection: "offline" } };
