import type { Meta, StoryObj } from "@storybook/react-vite";
import { SkillBrowser } from "../../components/assistant-ui/SkillPicker";

export default { title: "Chat & Messages/SkillBrowser", component: SkillBrowser, tags: ["autodocs"] } satisfies Meta<typeof SkillBrowser>;
type Story = StoryObj<typeof SkillBrowser>;
export const Empty: Story = { args: { agentLabel: "Atlas", registry: { status: "ready", items: [], total: 0 }, onBeforeOpen: () => {}, onSelect: () => {} } };
