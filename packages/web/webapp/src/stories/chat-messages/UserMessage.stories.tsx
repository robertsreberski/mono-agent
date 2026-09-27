import type { Meta, StoryObj } from "@storybook/react-vite";
import { UserMessage } from "../../components/Messages";
import { sampleMessages } from "../runtime";
import { Transcript } from "../transcript";
export default { title: "Chat & Messages/UserMessage", component: UserMessage, tags: ["autodocs"] } satisfies Meta<typeof UserMessage>;
type Story = StoryObj<typeof UserMessage>;
export const PlainText: Story = { render: () => <Transcript messages={[sampleMessages[0]!]} /> };
export const LongText: Story = { render: () => <Transcript messages={[{ role: "user", content: "Morgan wants a fictional garden layout. ".repeat(20) }]} /> };
export const Mobile: Story = { render: () => <Transcript messages={[sampleMessages[0]!]} />, globals: { viewport: { value: "phone" } } };
