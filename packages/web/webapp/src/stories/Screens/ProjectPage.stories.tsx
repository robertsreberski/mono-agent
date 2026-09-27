import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProjectPage } from "../../components/project/ProjectPage";
import { gardenProject } from "../fixtures";
import { StoryRuntime } from "../runtime";
export default { title: "Screens/ProjectPage", component: ProjectPage, tags: ["autodocs"], decorators: [(Story) => <StoryRuntime><div style={{ width: 400, maxWidth: "100%", minHeight: 740, background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 12 }}><Story /></div></StoryRuntime>] } satisfies Meta<typeof ProjectPage>;
type Story = StoryObj<typeof ProjectPage>;
export const WithMembers: Story = { args: { project: gardenProject } };
export const Empty: Story = { args: { project: { ...gardenProject, conversationCount: 0 } } };
export const Phone: Story = { args: { project: gardenProject }, globals: { viewport: { value: "phone" } } };
