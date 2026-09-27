import type { Meta, StoryObj } from "@storybook/react-vite";
import { QuoteBlock } from "../../components/assistant-ui/Quote";

export default { title: "Primitives/QuoteBlock", component: QuoteBlock, tags: ["autodocs"] } satisfies Meta<typeof QuoteBlock>;
type Story = StoryObj<typeof QuoteBlock>;
export const Short: Story = { args: { messageId: "fictional-message", text: "Morgan wants a garden plan." } };
export const Long: Story = { args: { messageId: "fictional-message", text: "A garden plan with two planting cycles, shaded beds, draft notes, and a schedule for checking seedlings next month." } };
