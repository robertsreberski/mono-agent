import type { Meta, StoryObj } from "@storybook/react-vite";
import { Dashboard } from "../../components/dashboard/Dashboard";
import { Chat } from "../../components/Chat";
import { StoryRuntime } from "../runtime";
import { RecentFixtures } from "../screen-fixtures";

function DashboardShell({ children, phone = false }: { readonly children: React.ReactNode; readonly phone?: boolean }) {
  return <StoryRuntime><div className="app-shell">
    <div className="dashboard-panel" role="navigation" aria-label="Dashboard">{children}<RecentFixtures /></div>
    {!phone && <div className="chat-region is-open"><Chat onBack={() => {}} /></div>}
  </div></StoryRuntime>;
}
export default {
  title: "Screens/Dashboard", component: Dashboard, tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  decorators: [(Story, context) => <DashboardShell phone={context.globals.viewport?.value === "phone"}><Story /></DashboardShell>],
} satisfies Meta<typeof Dashboard>;
type Story = StoryObj<typeof Dashboard>;
export const Desktop: Story = { args: { highlightSelected: true } };
export const Phone: Story = { args: { highlightSelected: false }, globals: { viewport: { value: "phone" } } };
