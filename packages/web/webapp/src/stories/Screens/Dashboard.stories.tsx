import type { Meta, StoryObj } from "@storybook/react-vite";
import { Dashboard } from "../../components/dashboard/Dashboard";
import { StoryRuntime } from "../runtime";
export default { title: "Screens/Dashboard", component: Dashboard, tags: ["autodocs"], decorators: [(Story) => <StoryRuntime><div style={{ width: 400, maxWidth: "100%", minHeight: 740, background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 12 }}><Story /></div></StoryRuntime>] } satisfies Meta<typeof Dashboard>;
type Story = StoryObj<typeof Dashboard>;
export const Desktop: Story = { args: { highlightSelected: true } };
export const Phone: Story = { args: { highlightSelected: false }, globals: { viewport: { value: "phone" } } };
