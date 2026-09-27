import type { Meta, StoryObj } from "@storybook/react-vite";
import { DataModeIndicator } from "../../components/DataModeIndicator";
export default { title: "Primitives/DataModeIndicator", component: DataModeIndicator, tags: ["autodocs"] } satisfies Meta<typeof DataModeIndicator>;
type Story = StoryObj<typeof DataModeIndicator>;
export const Default: Story = {};
export const Mobile: Story = { globals: { viewport: { value: "phone" } } };
