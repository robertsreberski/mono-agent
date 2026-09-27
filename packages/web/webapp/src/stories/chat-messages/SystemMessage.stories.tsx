import type { Meta, StoryObj } from "@storybook/react-vite";
import { SystemMessage } from "../../components/Messages";
import { sampleMessages } from "../runtime";
import { Transcript } from "../transcript";
export default { title: "Chat & Messages/SystemMessage", component: SystemMessage, tags: ["autodocs"] } satisfies Meta<typeof SystemMessage>;
type Story = StoryObj<typeof SystemMessage>;
export const ProjectContext: Story = { render: () => <Transcript messages={[sampleMessages[2]!]} /> };
export const Mobile: Story = { render: () => <Transcript messages={[sampleMessages[2]!]} />, globals: { viewport: { value: "phone" } } };
