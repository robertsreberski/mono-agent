import type { Meta, StoryObj } from "@storybook/react-vite";
import { ReasoningRoot, ReasoningTrigger, ReasoningContent, ReasoningText } from "../../components/assistant-ui/Reasoning";
import { StoryRuntime } from "../runtime";
const reasoning = <><ReasoningTrigger /><ReasoningContent><ReasoningText>Compare shaded and sunny beds in the fictional garden plan.</ReasoningText></ReasoningContent></>;
export default { title: "Chat & Messages/Reasoning", component: ReasoningRoot, tags: ["autodocs"], decorators: [(Story) => <StoryRuntime><Story /></StoryRuntime>] } satisfies Meta<typeof ReasoningRoot>;
type Story = StoryObj<typeof ReasoningRoot>;
export const Collapsed: Story = { args: { children: reasoning } };
export const Mobile: Story = { args: { children: reasoning }, globals: { viewport: { value: "phone" } } };
