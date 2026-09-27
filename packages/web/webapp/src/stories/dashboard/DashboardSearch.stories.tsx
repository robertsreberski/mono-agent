import type { Meta, StoryObj } from "@storybook/react-vite";
import { DashboardSearch } from "../../components/dashboard/DashboardSearch";

export default { title: "Dashboard/DashboardSearch", component: DashboardSearch, tags: ["autodocs"] } satisfies Meta<typeof DashboardSearch>;
type Story = StoryObj<typeof DashboardSearch>;
export const Empty: Story = { args: { value: "", onChange: () => {} } };
export const Query: Story = { args: { value: "garden", onChange: () => {} } };
export const LongQuery: Story = { args: { value: "Garden planner with community events and seed catalog", onChange: () => {} } };
