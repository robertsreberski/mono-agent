import type { Meta, StoryObj } from "@storybook/react-vite";
import { TagChip } from "../../components/tag/TagChip";

export default { title: "Projects & Tags/TagChip", component: TagChip, tags: ["autodocs"] } satisfies Meta<typeof TagChip>;
type Story = StoryObj<typeof TagChip>;
export const Research: Story = { args: { tag: { name: "Research", color: "green" } } };
export const LongLabel: Story = { args: { tag: { name: "Long-term botanical research and illustration", color: "blue" } } };
