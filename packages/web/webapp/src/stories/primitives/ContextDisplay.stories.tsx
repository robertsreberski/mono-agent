import type { Meta, StoryObj } from "@storybook/react-vite";
import { ContextDisplay } from "../../components/assistant-ui/ContextDisplay";

export default { title: "Primitives/ContextDisplay", component: ContextDisplay, tags: ["autodocs"] } satisfies Meta<typeof ContextDisplay>;
type Story = StoryObj<typeof ContextDisplay>;
export const Current: Story = { args: { context: { status: "current", usage: { total: 6400, contextWindow: 32000 } }, processed: { input: 3200, output: 1200 }, conversationCost: 0.02 } };
export const AwaitingMeasurement: Story = { args: { context: { status: "awaiting_measurement" } } };
