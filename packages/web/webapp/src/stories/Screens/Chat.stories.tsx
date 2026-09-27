import type { Meta, StoryObj } from "@storybook/react-vite";
import { Chat } from "../../components/Chat";
import { StoryRuntime } from "../runtime";
export default { title: "Screens/Chat", component: Chat, tags: ["autodocs"], decorators: [(Story) => <StoryRuntime><div style={{ width: "min(100%, 920px)", height: "80vh", background: "var(--surface)", border: "1px solid var(--line)" }}><Story /></div></StoryRuntime>] } satisfies Meta<typeof Chat>;
type Story = StoryObj<typeof Chat>;
export const Desktop: Story = { args: { onBack: () => {} } };
export const Phone: Story = { args: { onBack: () => {} }, globals: { viewport: { value: "phone" } } };
