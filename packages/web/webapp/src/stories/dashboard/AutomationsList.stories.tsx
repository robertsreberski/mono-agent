import type { Meta, StoryObj } from "@storybook/react-vite";
import { AutomationsList } from "../../components/AutomationsList";

export default { title: "Dashboard/AutomationsList", component: AutomationsList, tags: ["autodocs"] } satisfies Meta<typeof AutomationsList>;
type Story = StoryObj<typeof AutomationsList>;
export const Empty: Story = { args: { query: "" } };
export const Filtered: Story = { args: { query: "garden" } };
