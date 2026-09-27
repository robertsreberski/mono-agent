import type { Meta, StoryObj } from "@storybook/react-vite";
import { Composer } from "../../components/Composer";
import { StoryRuntime } from "../runtime";
export default { title: "Chat & Messages/Composer", component: Composer, tags: ["autodocs"], decorators: [(Story) => <StoryRuntime><div style={{ width: 720, maxWidth: "100%" }}><Story /></div></StoryRuntime>] } satisfies Meta<typeof Composer>;
type Story = StoryObj<typeof Composer>;
export const Empty: Story = { args: {} };
export const WithNotice: Story = { args: { notice: <p>Example: a garden plan is ready.</p> } };
export const Mobile: Story = { args: {}, globals: { viewport: { value: "phone" } } };
