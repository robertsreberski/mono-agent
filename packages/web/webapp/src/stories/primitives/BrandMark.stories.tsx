import type { Meta, StoryObj } from "@storybook/react-vite";
import { BrandMark } from "../../components/BrandMark";

export default { title: "Primitives/BrandMark", component: BrandMark, tags: ["autodocs"] } satisfies Meta<typeof BrandMark>;
type Story = StoryObj<typeof BrandMark>;
export const Default: Story = {};
