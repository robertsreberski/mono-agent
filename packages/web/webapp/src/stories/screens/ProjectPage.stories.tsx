import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";
import { ProjectPage } from "../../components/project/ProjectPage";
import { Chat } from "../../components/Chat";
import { gardenProject, gardenThread, runningThread } from "../fixtures";
import { storyStore } from "../store";
import { StoryRuntime } from "../runtime";

function ProjectShell({ children, empty = false, phone = false }: { readonly children: React.ReactNode; readonly empty?: boolean; readonly phone?: boolean }) {
  if (empty) Object.assign(storyStore, { projectMembers: [] });
  useEffect(() => () => { if (empty) Object.assign(storyStore, { projectMembers: [gardenThread, runningThread] }); }, [empty]);
  return <StoryRuntime><div className="app-shell">
    <div className="dashboard-panel" role="navigation" aria-label="Project">{children}</div>
    {!phone && <div className="chat-region is-open"><Chat onBack={() => {}} /></div>}
  </div></StoryRuntime>;
}
export default {
  title: "Screens/ProjectPage", component: ProjectPage, tags: ["autodocs"], parameters: { layout: "fullscreen" },
  decorators: [(Story, context) => <ProjectShell empty={context.parameters.empty === true} phone={context.globals.viewport?.value === "phone"}><Story /></ProjectShell>],
} satisfies Meta<typeof ProjectPage>;
type Story = StoryObj<typeof ProjectPage>;
export const WithMembers: Story = { args: { project: gardenProject } };
export const Empty: Story = { args: { project: { ...gardenProject, conversationCount: 0, runningCount: 0 } }, parameters: { empty: true } };
export const Phone: Story = { args: { project: gardenProject }, globals: { viewport: { value: "phone" } } };
