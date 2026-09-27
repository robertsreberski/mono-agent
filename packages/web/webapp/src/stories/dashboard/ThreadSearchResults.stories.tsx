import type { Meta, StoryObj } from "@storybook/react-vite";
import { ThreadSearchResults } from "../../components/ThreadSearchResults";

export default { title: "Dashboard/ThreadSearchResults", component: ThreadSearchResults, tags: ["autodocs"] } satisfies Meta<typeof ThreadSearchResults>;
type Story = StoryObj<typeof ThreadSearchResults>;
export const Empty: Story = { args: { query: "garden", search: { status: "idle", hits: [], truncated: false } } };
export const Loading: Story = { args: { query: "garden", search: { status: "loading", hits: [], truncated: false } } };
