import type { Meta, StoryObj } from "@storybook/react-vite";
import { Icon } from "../../components/Icon";
export default { title: "Primitives/Icon", component: Icon, tags: ["autodocs"], argTypes: { name: { control: "text" }, size: { control: { type: "range", min: 12, max: 48, step: 2 } } } } satisfies Meta<typeof Icon>;
type Story = StoryObj<typeof Icon>;
export const Agent: Story = { args: { name: "agent", size: 24 } };
export const Status: Story = { args: { name: "alert", size: 24 } };
export const Small: Story = { args: { name: "star", size: 12 } };
